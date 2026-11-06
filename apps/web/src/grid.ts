/**
 * The board's one grid: the dots, the snap points for a card's corner, and the steps its size moves
 * in, so all four corners of a card sit on dots (canon 02 revisions 19 to 21).
 */
export const GRID = 88

/** A position on the nearest grid point. */
export const snapTo = (n: number) => Math.round(n / GRID) * GRID

/** A size in whole grid steps, never under two of them. */
export const snapSize = (n: number) => Math.max(2 * GRID, Math.round(n / GRID) * GRID)
