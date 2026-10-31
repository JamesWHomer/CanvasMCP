// Grade calculator and quizzes (read-only).
import { z } from "zod";
import { compact, htmlToMarkdown } from "../format.js";
import { courseTotal, groupTotal, projectedFinal, requiredAverage, type GradeGroup } from "../grading.js";
import { READ_ONLY, courseId, submissionSummary, type Obj, type ToolContext } from "./shared.js";

const round = (n: number | null | undefined) => (n === null || n === undefined ? undefined : Math.round(n * 100) / 100);

export function registerAssessmentTools({ server, canvas, run }: ToolContext): void {
  server.registerTool(
    "calculate_grade",
    {
      title: "Grade calculator",
      description:
        "Work out where a course grade stands and what's needed: the current grade, the range of possible final grades, \"what if I get X on this assignment\" scenarios, and the average needed on all remaining work to reach a target (e.g. 85 for an HD, 75 D, 65 CR, 50 P). Uses Canvas's assignment group weights and drop rules. If some assessment (often the final exam) isn't set up in Canvas, pass its share of the final mark as outside_weight_percent.",
      inputSchema: {
        course_id: courseId,
        target_percent: z.number().min(0).max(100).optional().describe("Final grade to aim for, e.g. 85"),
        what_if: z
          .array(
            z.object({
              assignment_id: z.coerce.string(),
              score: z.number().min(0).optional().describe("Points earned"),
              percent: z.number().min(0).max(200).optional().describe("Or a percentage of the points possible"),
            }),
          )
          .optional()
          .describe("Hypothetical scores to apply before calculating"),
        outside_weight_percent: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Share of the final mark from assessments not in Canvas, e.g. 50 for a 50% exam"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, target_percent, what_if, outside_weight_percent }) =>
      run(async () => {
        const c = canvas();
        const [course, rawGroups] = await Promise.all([
          c.get<Obj>(`courses/${course_id}`, { include: ["total_scores"] }),
          c.getAll<Obj>(`courses/${course_id}/assignment_groups`, { include: ["assignments", "submission"] }),
        ]);
        const weighted = Boolean(course.apply_assignment_group_weights);
        const overrides = new Map((what_if ?? []).map((w) => [w.assignment_id, w]));
        const applied: string[] = [];

        const groups: GradeGroup[] = rawGroups.map((g) => ({
          name: g.name,
          weight: Number(g.group_weight ?? 0),
          dropLowest: Number(g.rules?.drop_lowest ?? 0),
          dropHighest: Number(g.rules?.drop_highest ?? 0),
          items: (g.assignments ?? [])
            .filter(
              (a: Obj) =>
                a.published !== false &&
                !a.omit_from_final_grade &&
                a.grading_type !== "not_graded" &&
                typeof a.points_possible === "number" &&
                !a.submission?.excused,
            )
            .map((a: Obj) => {
              const override = overrides.get(String(a.id));
              let score: number | null = typeof a.submission?.score === "number" ? a.submission.score : null;
              if (override) {
                score = override.score ?? ((override.percent ?? 0) / 100) * a.points_possible;
                applied.push(`${a.name}: ${round(score)}/${a.points_possible}`);
              }
              return {
                id: String(a.id),
                name: a.name,
                points: a.points_possible,
                score,
                neverDrop: (g.rules?.never_drop ?? []).map(String).includes(String(a.id)),
              };
            }),
        }));
        const unknown = [...overrides.keys()].filter((id) => !groups.some((g) => g.items.some((i) => i.id === id)));

        const outside = (outside_weight_percent ?? 0) / 100;
        const enrollment = course.enrollments?.find((e: Obj) => e.type === "student") ?? course.enrollments?.[0];
        const remaining = groups.flatMap((g) => g.items.filter((i) => i.score === null).map((i) => ({ g, i })));

        return compact({
          course: course.name,
          weighted_groups: weighted,
          canvas_current_score: enrollment?.computed_current_score,
          current_percent: round(courseTotal(groups, weighted)),
          final_if_remaining_scores_zero: round(projectedFinal(groups, weighted, 0, outside)),
          final_if_remaining_scores_full: round(projectedFinal(groups, weighted, 1, outside)),
          target:
            target_percent === undefined
              ? undefined
              : (() => {
                  const need = requiredAverage(groups, weighted, target_percent, outside);
                  return compact({
                    target_percent,
                    status: need.status,
                    average_needed_on_remaining: round(need.percent),
                  });
                })(),
          remaining_work: remaining.map(({ g, i }) => `${i.name} (${i.points} pts, ${g.name})`),
          outside_canvas_weight_percent: outside_weight_percent,
          groups: groups.map((g) => {
            const now = groupTotal(g);
            return compact({
              name: g.name,
              weight_percent: weighted ? g.weight : undefined,
              current_percent: round(now.percent),
              graded: `${round(now.score)}/${round(now.points)} pts`,
              ungraded_items: g.items.filter((i) => i.score === null).length || undefined,
              dropped: now.dropped,
            });
          }),
          what_if_applied: applied,
          what_if_unknown_ids: unknown,
          notes: [
            "Projections assume every remaining item scores the same percentage.",
            "Only grades already released to you are counted.",
            enrollment?.computed_current_score === undefined
              ? "This course hides its total from students, so these figures are an estimate from the visible assignments and weights. Check the unit outline for assessments not in Canvas (e.g. the final exam) and pass outside_weight_percent."
              : "Canvas's own figure is canvas_current_score.",
          ],
        });
      }),
  );

  server.registerTool(
    "list_quizzes",
    {
      title: "List quizzes",
      description:
        "List a course's quizzes (Classic and New Quizzes) with due dates, time limits, attempts and your score. Use get_quiz for a Classic quiz's details and attempt history; New Quizzes are assignments, so use get_assignment with their assignment_id.",
      inputSchema: { course_id: courseId },
      annotations: READ_ONLY,
    },
    async ({ course_id }) =>
      run(async () => {
        const c = canvas();
        const [classic, assignments] = await Promise.all([
          // Classic Quizzes may be disabled for a course; treat that as "none".
          c.getAll<Obj>(`courses/${course_id}/quizzes`).catch(() => [] as Obj[]),
          c.getAll<Obj>(`courses/${course_id}/assignments`, { include: ["submission"], order_by: "due_at" }),
        ]);
        const byId = new Map(assignments.map((a) => [String(a.id), a]));
        const classicList = classic.map((q) =>
          compact({
            kind: "classic",
            quiz_id: q.id,
            assignment_id: q.assignment_id,
            title: q.title,
            quiz_type: q.quiz_type,
            due_at: q.due_at,
            unlock_at: q.unlock_at,
            lock_at: q.lock_at,
            time_limit_minutes: q.time_limit,
            allowed_attempts: q.allowed_attempts === -1 ? "unlimited" : q.allowed_attempts,
            points_possible: q.points_possible,
            questions: q.question_count,
            locked: q.locked_for_user || undefined,
            submission: submissionSummary(byId.get(String(q.assignment_id))?.submission),
            url: q.html_url,
          }),
        );
        const newQuizzes = assignments
          .filter((a) => a.is_quiz_lti_assignment)
          .map((a) =>
            compact({
              kind: "new_quizzes",
              assignment_id: a.id,
              title: a.name,
              due_at: a.due_at,
              unlock_at: a.unlock_at,
              lock_at: a.lock_at,
              allowed_attempts: a.allowed_attempts === -1 ? "unlimited" : a.allowed_attempts,
              points_possible: a.points_possible,
              locked: a.locked_for_user || undefined,
              submission: submissionSummary(a.submission),
              url: a.html_url,
            }),
          );
        return [...classicList, ...newQuizzes].sort((a, b) =>
          String(a.due_at ?? "9999").localeCompare(String(b.due_at ?? "9999")),
        );
      }),
  );

  server.registerTool(
    "get_quiz",
    {
      title: "Get Classic quiz details",
      description:
        "Get a Classic quiz's instructions, settings and your attempt history (scores, times). For New Quizzes use get_assignment.",
      inputSchema: { course_id: courseId, quiz_id: z.coerce.string().describe("Classic quiz ID (from list_quizzes)") },
      annotations: READ_ONLY,
    },
    async ({ course_id, quiz_id }) =>
      run(async () => {
        const c = canvas();
        const base = `courses/${course_id}/quizzes/${quiz_id}`;
        const [q, subs] = await Promise.all([
          c.get<Obj>(base).catch((err: Error) => {
            throw new Error(`${err.message} (if this is a New Quiz, use get_assignment with its assignment_id)`);
          }),
          c.get<Obj>(`${base}/submissions`).catch(() => undefined),
        ]);
        return compact({
          quiz_id: q.id,
          assignment_id: q.assignment_id,
          title: q.title,
          quiz_type: q.quiz_type,
          due_at: q.due_at,
          unlock_at: q.unlock_at,
          lock_at: q.lock_at,
          time_limit_minutes: q.time_limit,
          allowed_attempts: q.allowed_attempts === -1 ? "unlimited" : q.allowed_attempts,
          scoring_policy: q.scoring_policy,
          points_possible: q.points_possible,
          questions: q.question_count,
          one_question_at_a_time: q.one_question_at_a_time || undefined,
          results_visible: { always: "never", until_after_last_attempt: "after the last attempt" }[
            q.hide_results as string
          ] ?? (q.hide_results === null ? "always" : undefined),
          locked: q.locked_for_user || undefined,
          lock_explanation: q.lock_explanation,
          description: htmlToMarkdown(q.description),
          url: q.html_url,
          attempts: subs?.quiz_submissions?.map((s: Obj) =>
            compact({
              attempt: s.attempt,
              state: s.workflow_state,
              score: s.score,
              kept_score: s.kept_score,
              started_at: s.started_at,
              finished_at: s.finished_at,
              minutes_spent: s.time_spent ? Math.round(s.time_spent / 60) : undefined,
            }),
          ),
        });
      }),
  );
}
