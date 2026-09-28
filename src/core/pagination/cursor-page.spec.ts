import type { SelectQueryBuilder } from 'typeorm';

import { fetchPageWithTotal } from './cursor-page';

/** Just enough of a query builder to see which copy each step touched. */
interface FakeBuilder {
  applied: string[];
  clone: jest.Mock<FakeBuilder, []>;
  getMany: jest.Mock<Promise<string[]>, []>;
  getCount: jest.Mock<Promise<number>, []>;
}

function builder(rows: string[]): FakeBuilder {
  const qb: FakeBuilder = {
    applied: [],
    clone: jest.fn((): FakeBuilder => {
      const copy = builder(rows);
      copy.applied = [...qb.applied];
      return copy;
    }),
    getMany: jest.fn(() => Promise.resolve(rows)),
    // A count taken after the page conditions would be wrong: say so loudly.
    getCount: jest.fn(() => Promise.resolve(qb.applied.length ? -1 : 42)),
  };
  return qb;
}

describe('fetchPageWithTotal', () => {
  it('counts the filtered query before the page conditions are added', async () => {
    const filtered = builder(['a', 'b']);

    const result = await fetchPageWithTotal(
      filtered as unknown as SelectQueryBuilder<object>,
      (page) => {
        (page as unknown as { applied: string[] }).applied.push('keyset');
      },
    );

    // The page query got the keyset; the count ran on an untouched clone.
    expect(filtered.applied).toEqual(['keyset']);
    expect(result).toEqual({ rows: ['a', 'b'], total: 42 });
    expect(filtered.getMany).toHaveBeenCalledTimes(1);
    expect(filtered.getCount).not.toHaveBeenCalled();
  });
});
