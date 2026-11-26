import { FinishingType, PaperSize, PrintType, Sides, UserRole } from '@prisma/client';

import { ValidationError } from '../../utils/errors';
import * as pricingService from '../pricing.service';
import * as shopService from '../shop.service';
import { isLlmConfigured, parsePrintRequestWithLlm } from './printRequest.llm';
import {
  ParsedPrintRequest,
  findNamedShop,
  parsePrintRequestWithRules,
} from './printRequest.parser';

export const MAX_MESSAGE_LENGTH = 500;
const MAX_DOCUMENTS = 10;

export interface AssistantResult {
  // Only what was understood; the client merges it over its own defaults.
  settings: {
    printType?: PrintType;
    paperSize?: PaperSize;
    sides?: Sides;
    copies?: number;
    pageRange?: string;
    finishingType?: FinishingType;
    specialInstructions?: string;
  };
  shopId: string | null;
  shopName: string | null;
  finishingRuleId: string | null;
  estimatedTotal: string | null;
  notes: string[];
  source: 'ai' | 'rules';
}

interface Candidate {
  shopId: string;
  shopName: string;
  total: number;
  totalText: string;
  finishingRuleId: string | null;
}

export async function interpretPrintRequest(
  userId: string,
  role: UserRole,
  input: { message: unknown; documentIds?: unknown },
): Promise<AssistantResult> {
  if (typeof input.message !== 'string' || !input.message.trim()) {
    throw new ValidationError('message is required');
  }
  const message = input.message.trim();
  if (message.length > MAX_MESSAGE_LENGTH) {
    throw new ValidationError(`message must be at most ${MAX_MESSAGE_LENGTH} characters`);
  }
  let documentIds: string[] = [];
  if (input.documentIds !== undefined) {
    if (
      !Array.isArray(input.documentIds) ||
      input.documentIds.length > MAX_DOCUMENTS ||
      input.documentIds.some((id) => typeof id !== 'string')
    ) {
      throw new ValidationError(`documentIds must be an array of at most ${MAX_DOCUMENTS} ids`);
    }
    documentIds = input.documentIds as string[];
  }

  const allShops = await shopService.listShops();
  const openShops = allShops.filter((s) => s.isActive && s.acceptingOrders);

  let parsed: ParsedPrintRequest | null = null;
  let source: AssistantResult['source'] = 'rules';
  if (isLlmConfigured()) {
    parsed = await parsePrintRequestWithLlm(message, openShops.map((s) => s.shopName));
    if (parsed) source = 'ai';
  }
  parsed ??= parsePrintRequestWithRules(message);

  const notes: string[] = [];
  const settings: AssistantResult['settings'] = {};
  if (parsed.printType) settings.printType = parsed.printType;
  if (parsed.paperSize) settings.paperSize = parsed.paperSize;
  if (parsed.sides) settings.sides = parsed.sides;
  if (parsed.copies) settings.copies = parsed.copies;
  if (parsed.pageRange) settings.pageRange = parsed.pageRange;
  if (parsed.finishingType) settings.finishingType = parsed.finishingType;
  if (parsed.colourCoverOnly) {
    settings.specialInstructions = 'Print the cover page in colour; everything else in black and white.';
    notes.push(
      'Colour on the cover page only is sent to the shop as an instruction, and priced as black and white. The shop may charge extra for the colour page.',
    );
  }
  if (Object.keys(parsed).length === 0) {
    notes.push('I could not find any print settings in that message. Try e.g. "2 copies, double-sided, colour, spiral bind".');
  }

  // Which shops could serve this? A named shop is honoured exactly; otherwise
  // every open shop competes on the real price the pricing preview returns.
  const named = findNamedShop(message, openShops, parsed.shopName);
  if (!named && (parsed.shopName || /\bat\s+\w+\s+shop\b/i.test(message))) {
    notes.push('I could not match that shop name, so I picked from all open shops.');
  }
  const candidates = named ? [named] : openShops;

  const priced: Candidate[] = [];
  if (documentIds.length > 0) {
    for (const shop of candidates) {
      try {
        let finishingRuleId: string | null = null;
        if (parsed.finishingType) {
          const rules = await pricingService.listFinishingRules(shop.shopId, { current: true });
          const rule = rules.find((r) => r.finishingType === parsed.finishingType);
          if (!rule) continue; // this shop cannot do the requested finishing
          finishingRuleId = rule.finishingRuleId;
        }
        const preview = await pricingService.calculatePricingPreview(
          userId,
          {
            shopId: shop.shopId,
            items: documentIds.map((documentId) => ({
              documentId,
              copies: parsed.copies ?? 1,
              printType: parsed.printType ?? 'BW',
              paperSize: parsed.paperSize ?? 'A4',
              sides: parsed.sides ?? 'SINGLE',
              pageRange: parsed.pageRange,
              finishingRuleId: finishingRuleId ?? undefined,
            })),
          },
          role,
        );
        priced.push({
          shopId: shop.shopId,
          shopName: shop.shopName,
          total: Number(preview.totalAmount),
          totalText: preview.totalAmount,
          finishingRuleId,
        });
      } catch {
        // Shop has no matching pricing rule, is not open to this role, or
        // the page range does not fit the document - not a candidate.
      }
    }
  }

  let chosen: Candidate | undefined;
  if (priced.length > 0) {
    chosen = priced.reduce((best, c) => (c.total < best.total ? c : best));
    notes.push(
      named
        ? `Priced at ${chosen.shopName}.`
        : `${chosen.shopName} is the cheapest of ${priced.length} shop${priced.length === 1 ? '' : 's'} that can do this.`,
    );
  } else if (documentIds.length > 0) {
    notes.push(
      named
        ? `${named.shopName} cannot price these settings. Pick another shop manually.`
        : 'No open shop can do these exact settings. Pick a shop manually.',
    );
  } else if (named) {
    notes.push('Select documents first to get a price.');
  }

  const shop = chosen ?? (named && documentIds.length === 0 ? named : undefined);
  return {
    settings,
    shopId: shop ? shop.shopId : null,
    shopName: shop ? shop.shopName : null,
    finishingRuleId: chosen?.finishingRuleId ?? null,
    estimatedTotal: chosen?.totalText ?? null,
    notes,
    source,
  };
}
