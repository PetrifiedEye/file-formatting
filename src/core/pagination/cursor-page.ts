import { SelectQueryBuilder } from 'typeorm';

/** One page of a cursor-paginated list. */
export interface CursorPage<T> {
  items: T[];
  /** `null` on the last page — always present, never an empty string. */
  nextCursor: string | null;
  /**
   * How many items match the query's filters across every page. Independent
   * of the cursor, so it stays the same while a client walks the pages.
   */
  total: number;
}

/**
 * Runs a keyset page query and its total count side by side.
 *
 * `filtered` must carry the filters only; `applyPage` adds the keyset
 * condition, the order and the `limit + 1` take to its own copy. The count is
 * taken from an untouched clone, so it is the size of the whole filtered list
 * rather than of what remains after the cursor.
 */
export async function fetchPageWithTotal<E extends object>(
  filtered: SelectQueryBuilder<E>,
  applyPage: (qb: SelectQueryBuilder<E>) => void,
): Promise<{ rows: E[]; total: number }> {
  const countQuery = filtered.clone();

  applyPage(filtered);

  const [rows, total] = await Promise.all([
    filtered.getMany(),
    countQuery.getCount(),
  ]);

  return { rows, total };
}
