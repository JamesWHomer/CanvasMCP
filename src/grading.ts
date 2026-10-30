// Course grade maths, mirroring how Canvas totals assignment groups (weights, drop rules, excused work).

export interface GradeItem {
  id: string;
  name: string;
  points: number;
  /** Points earned, or null while ungraded. */
  score: number | null;
  neverDrop: boolean;
}

export interface GradeGroup {
  name: string;
  weight: number;
  dropLowest: number;
  dropHighest: number;
  items: GradeItem[];
}

export interface GroupTotal {
  score: number;
  points: number;
  percent: number | null;
  dropped: string[];
}

/**
 * Totals one group. With `fill` undefined only graded work counts (Canvas's "current" grade);
 * with a fill fraction, ungraded work is assumed to score that fraction of its points.
 */
export function groupTotal(group: GradeGroup, fill?: number): GroupTotal {
  const counted = group.items
    .map((item) => ({ ...item, earned: item.score ?? (fill === undefined ? null : fill * item.points) }))
    .filter((item): item is GradeItem & { earned: number } => item.earned !== null);

  // Drop by percentage, never below one remaining droppable item, as Canvas does.
  const droppable = counted
    .filter((i) => !i.neverDrop && i.points > 0)
    .sort((a, b) => a.earned / a.points - b.earned / b.points);
  const lowest = droppable.slice(0, Math.min(group.dropLowest, Math.max(droppable.length - 1, 0)));
  const rest = droppable.slice(lowest.length);
  const highest = rest.slice(Math.max(rest.length - Math.min(group.dropHighest, Math.max(rest.length - 1, 0)), 0));
  const dropped = new Set([...lowest, ...highest].map((i) => i.id));

  const kept = counted.filter((i) => !dropped.has(i.id));
  const score = kept.reduce((sum, i) => sum + i.earned, 0);
  const points = kept.reduce((sum, i) => sum + i.points, 0);
  return {
    score,
    points,
    percent: points > 0 ? (score / points) * 100 : null,
    dropped: counted.filter((i) => dropped.has(i.id)).map((i) => i.name),
  };
}

/**
 * Course percentage. Weighted courses renormalise over groups that have counted work, so a group with
 * nothing graded yet doesn't drag the current grade down; unweighted courses sum points across groups.
 */
export function courseTotal(groups: GradeGroup[], weighted: boolean, fill?: number): number | null {
  const totals = groups.map((g) => ({ g, t: groupTotal(g, fill) }));
  if (weighted) {
    let weightedSum = 0;
    let weights = 0;
    for (const { g, t } of totals) {
      if (t.percent === null || g.weight <= 0) continue;
      weightedSum += g.weight * t.percent;
      weights += g.weight;
    }
    return weights > 0 ? weightedSum / weights : null;
  }
  const score = totals.reduce((sum, { t }) => sum + t.score, 0);
  const points = totals.reduce((sum, { t }) => sum + t.points, 0);
  return points > 0 ? (score / points) * 100 : null;
}

/**
 * Final mark if every ungraded item (and any assessment outside Canvas) scores `fill` of its marks.
 * `outsideWeight` is the share (0-1) of the final mark coming from assessments not set up in Canvas.
 */
export function projectedFinal(groups: GradeGroup[], weighted: boolean, fill: number, outsideWeight = 0): number {
  const inCanvas = courseTotal(groups, weighted, fill) ?? fill * 100;
  return (1 - outsideWeight) * inCanvas + outsideWeight * fill * 100;
}

/** Smallest uniform percentage on all remaining work that reaches `target`, by bisection (the total is monotonic). */
export function requiredAverage(
  groups: GradeGroup[],
  weighted: boolean,
  target: number,
  outsideWeight = 0,
): { status: "already secured" | "achievable" | "not achievable"; percent?: number } {
  const at = (fill: number) => projectedFinal(groups, weighted, fill, outsideWeight);
  if (at(0) >= target) return { status: "already secured", percent: 0 };
  if (at(1) < target) return { status: "not achievable", percent: undefined };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) >= target) hi = mid;
    else lo = mid;
  }
  return { status: "achievable", percent: hi * 100 };
}
