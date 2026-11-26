import {
  findNamedShop,
  parsePrintRequestWithRules,
  sanitizeParsedRequest,
} from '../src/services/assistant/printRequest.parser';

describe('parsePrintRequestWithRules', () => {
  it('understands the example from the feature brief', () => {
    const parsed = parsePrintRequestWithRules(
      'print my 40-page report double-sided, colour cover only, spiral bind, cheapest shop',
    );
    expect(parsed).toMatchObject({
      sides: 'DOUBLE',
      printType: 'BW',
      colourCoverOnly: true,
      finishingType: 'SPIRAL_BINDING',
      wantsCheapest: true,
    });
  });

  it('parses copies, colour, paper size and page ranges', () => {
    expect(parsePrintRequestWithRules('3 copies in colour on A3, pages 2 to 5, 9')).toMatchObject({
      copies: 3,
      printType: 'COLOR',
      paperSize: 'A3',
      pageRange: '2-5,9',
    });
    expect(parsePrintRequestWithRules('two copies black and white')).toMatchObject({
      copies: 2,
      printType: 'BW',
    });
  });

  it('returns nothing for an unrelated message', () => {
    expect(parsePrintRequestWithRules('hello there')).toEqual({});
  });
});

describe('sanitizeParsedRequest', () => {
  it('drops invalid or hostile values', () => {
    expect(
      sanitizeParsedRequest({
        printType: 'RAINBOW',
        paperSize: 'A0',
        copies: 5000,
        pageRange: '1-3; DROP TABLE',
        finishingType: 'NONE',
        sides: 'DOUBLE',
        extra: 'ignored',
      }),
    ).toEqual({ sides: 'DOUBLE' });
  });
});

describe('findNamedShop', () => {
  const shops = [
    { shopName: 'G Block Print', shopCode: 'G_BLOCK' },
    { shopName: 'COS Xerox', shopCode: 'COS' },
  ];
  it('matches by name or code, case-insensitively', () => {
    expect(findNamedShop('use the g block print please', shops)?.shopCode).toBe('G_BLOCK');
    expect(findNamedShop('at cos', shops)?.shopCode).toBe('COS');
    expect(findNamedShop('anywhere', shops)).toBeUndefined();
  });
});
