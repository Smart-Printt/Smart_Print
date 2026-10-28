import { OrderStatus } from '@prisma/client';

import { ValidationError } from './errors';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
// Keeps `skip` (page * limit) far below anything that could be abused to make
// the database scan millions of rows.
const MAX_PAGE = 10_000;
const MAX_SEARCH_LENGTH = 40;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ORDER_STATUSES = new Set<string>(Object.values(OrderStatus));

export interface OrderListQuery {
  page: number;
  limit: number;
  // Empty means "any status".
  statuses: OrderStatus[];
  from?: Date;
  to?: Date;
  shopId?: string;
  // Case-insensitive "contains" match on the order code.
  search?: string;
}

// Query-string values arrive as string | string[] | object | undefined. A
// repeated or nested parameter (?page=1&page=2, ?page[a]=1) is rejected
// instead of being guessed at.
function single(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ValidationError(`${name} must be given once, as plain text`);
  }
  return value;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]+$/.test(raw)) {
    throw new ValidationError(`${name} must be a whole number`);
  }
  const value = Number(raw);
  if (value < 1 || value > max) {
    throw new ValidationError(`${name} must be between 1 and ${max}`);
  }
  return value;
}

export function parseDateParam(name: string, raw: string | undefined): Date | undefined {
  if (raw === undefined || raw === '') return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError(`${name} must be a valid date (e.g. 2026-10-28 or 2026-10-28T10:00:00Z)`);
  }
  return date;
}

function parseStatuses(raw: string | undefined): OrderStatus[] {
  if (raw === undefined || raw.trim() === '') return [];
  const parts = [...new Set(raw.split(',').map((part) => part.trim()).filter(Boolean))];
  for (const part of parts) {
    if (!ORDER_STATUSES.has(part)) {
      throw new ValidationError(`Unknown order status "${part.slice(0, 40)}"`);
    }
  }
  return parts as OrderStatus[];
}

export function parseOrderListQuery(query: Record<string, unknown>): OrderListQuery {
  const page = parsePositiveInt('page', single('page', query.page), 1, MAX_PAGE);
  const limit = parsePositiveInt('limit', single('limit', query.limit), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const statuses = parseStatuses(single('status', query.status));
  const from = parseDateParam('from', single('from', query.from));
  const to = parseDateParam('to', single('to', query.to));
  if (from && to && from > to) {
    throw new ValidationError('from must not be after to');
  }

  const shopIdRaw = single('shopId', query.shopId)?.trim();
  if (shopIdRaw && !UUID_PATTERN.test(shopIdRaw)) {
    throw new ValidationError('shopId must be a valid id');
  }

  const searchRaw = single('q', query.q)?.trim();
  if (searchRaw && searchRaw.length > MAX_SEARCH_LENGTH) {
    throw new ValidationError(`q must be at most ${MAX_SEARCH_LENGTH} characters`);
  }

  return {
    page,
    limit,
    statuses,
    from,
    to,
    shopId: shopIdRaw || undefined,
    search: searchRaw || undefined,
  };
}
