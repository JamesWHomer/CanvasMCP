// The original read-only tools: profile, courses, planner, assignments, content, files, grades, discussions.
import { z } from "zod";
import type { Params } from "../canvas.js";
import { compact, htmlToMarkdown, richTextToMarkdown, truncate } from "../format.js";
import {
  DAY_MS,
  READ_ONLY,
  activeCourseIds,
  assignmentGroup,
  attachmentList,
  courseId,
  groupInfo,
  resolveRange,
  submissionSummary,
  uploadedBy,
  type Obj,
  type ToolContext,
} from "./shared.js";

export function registerCoreTools({ server, canvas, run }: ToolContext): void {
  server.registerTool(
    "get_profile",
    {
      title: "Get my Canvas profile",
      description:
        "Get the signed-in Canvas user's name, ID, email and time zone. Use it to check the connection works. Other tools already give timestamps in this time zone, with its UTC offset.",
      annotations: READ_ONLY,
    },
    async () =>
      run(async () => {
        const c = canvas();
        const p = await c.get<Obj>("users/self/profile");
        return compact({
          id: p.id,
          name: p.name,
          short_name: p.short_name,
          email: p.primary_email,
          login_id: p.login_id,
          time_zone: p.time_zone,
          locale: p.locale,
          canvas_url: c.origin,
        });
      }),
  );

  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description:
        "List the user's Canvas courses with IDs, term and current overall grade. Call this first to find the course_id other tools need.",
      inputSchema: {
        include_completed: z
          .boolean()
          .optional()
          .describe("Also include past/concluded courses (default: only currently active enrollments)"),
      },
      annotations: READ_ONLY,
    },
    async ({ include_completed }) =>
      run(async () => {
        const params: Params = { include: ["term", "total_scores"] };
        if (include_completed) params.state = ["available", "completed"];
        else params.enrollment_state = "active";
        const courses = await canvas().getAll<Obj>("courses", params);
        return courses
          .filter((x) => !x.access_restricted_by_date)
          .map((x) => {
            const e = x.enrollments?.find((en: Obj) => en.type === "student") ?? x.enrollments?.[0];
            return compact({
              id: x.id,
              name: x.name,
              code: x.course_code,
              term: x.term?.name,
              role: e?.type,
              current_score: e?.computed_current_score,
              current_grade: e?.computed_current_grade,
              start_at: x.start_at,
              end_at: x.end_at,
            });
          });
      }),
  );

  server.registerTool(
    "get_planner",
    {
      title: "Planner: what's due",
      description:
        "List to-do items across all courses (assignments, quizzes, discussions, announcements, calendar events, personal planner notes) in a date range, with submission status. Best tool for questions like \"what's due this week?\" or \"what am I missing?\". Defaults to today (in the user's time zone) through the next 14 days; set start_date in the past to find missing work. Each item's type and id can be passed to set_planner_item_done when writes are enabled.",
      inputSchema: {
        start_date: z
          .string()
          .optional()
          .describe("Date (whole day, user's time zone) or ISO datetime, e.g. 2026-10-30. Default: start of today."),
        end_date: z
          .string()
          .optional()
          .describe("Date (inclusive) or ISO datetime. Default: 14 days after start_date."),
        course_id: courseId.optional().describe("Limit to one course"),
        incomplete_only: z.boolean().optional().describe("Only items not yet submitted or marked done"),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, course_id, incomplete_only }) =>
      run(async () => {
        const c = canvas();
        const { start, end } = await resolveRange(c, start_date, end_date, 14);
        const items = await c.getAll<Obj>("planner/items", {
          start_date: start.toISOString(),
          end_date: end.toISOString(),
          context_codes: course_id ? [`course_${course_id}`] : undefined,
          filter: incomplete_only ? "incomplete_items" : undefined,
        });
        return items.map((item) => {
          const p = item.plannable ?? {};
          const s = item.submissions;
          return compact({
            type: item.plannable_type,
            id: item.plannable_id,
            title: p.title ?? p.name,
            course: item.context_name,
            course_id: item.course_id,
            due_at: item.plannable_date,
            points_possible: p.points_possible,
            status: s
              ? compact({
                  submitted: s.submitted,
                  graded: s.graded,
                  late: s.late || undefined,
                  missing: s.missing || undefined,
                  excused: s.excused || undefined,
                  has_feedback: s.has_feedback || undefined,
                })
              : undefined,
            marked_complete: item.planner_override?.marked_complete || undefined,
            url: item.html_url ? c.absoluteUrl(item.html_url) : undefined,
          });
        });
      }),
  );

  server.registerTool(
    "list_assignments",
    {
      title: "List assignments in a course",
      description:
        "List a course's assignments ordered by due date, with the user's submission status and score. Use get_assignment for the full instructions and rubric.",
      inputSchema: {
        course_id: courseId,
        bucket: z
          .enum(["past", "overdue", "undated", "ungraded", "unsubmitted", "upcoming", "future"])
          .optional()
          .describe("Filter by status/time bucket"),
        search: z.string().optional().describe("Filter by assignment name"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, bucket, search }) =>
      run(async () => {
        const assignments = await canvas().getAll<Obj>(`courses/${course_id}/assignments`, {
          include: ["submission"],
          order_by: "due_at",
          bucket,
          search_term: search,
        });
        return assignments.map((a) =>
          compact({
            id: a.id,
            name: a.name,
            due_at: a.due_at,
            unlock_at: a.unlock_at,
            lock_at: a.lock_at,
            points_possible: a.points_possible,
            submission_types: a.submission_types,
            group_assignment: a.group_category_id ? true : undefined,
            url: a.html_url,
            submission: submissionSummary(a.submission),
          }),
        );
      }),
  );

  server.registerTool(
    "get_assignment",
    {
      title: "Get assignment details",
      description:
        "Get one assignment's full instructions (as Markdown), rubric, allowed submission types, group details for group assignments, and the user's submission including files, score, rubric marks and instructor comments. To just check submission status, get_submission is much shorter.",
      inputSchema: {
        course_id: courseId,
        assignment_id: z.coerce.string().describe("Assignment ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, assignment_id }) =>
      run(async () => {
        const c = canvas();
        const base = `courses/${course_id}/assignments/${assignment_id}`;
        const [a, sub] = await Promise.all([
          c.get<Obj>(base),
          // Teachers and observers have no "self" submission; that's fine, just leave it out.
          c
            .get<Obj>(`${base}/submissions/self`, { include: ["submission_comments", "rubric_assessment"] })
            .catch(() => undefined),
        ]);
        const marks: Obj = sub?.rubric_assessment ?? {};
        const group = await assignmentGroup(c, a);
        return compact({
          id: a.id,
          name: a.name,
          url: a.html_url,
          due_at: a.due_at,
          unlock_at: a.unlock_at,
          lock_at: a.lock_at,
          points_possible: a.points_possible,
          grading_type: a.grading_type,
          submission_types: a.submission_types,
          allowed_extensions: a.allowed_extensions,
          allowed_attempts: a.allowed_attempts === -1 ? "unlimited" : a.allowed_attempts,
          quiz_id: a.quiz_id,
          discussion_topic_id: a.discussion_topic?.id,
          group: groupInfo(a, group),
          description: htmlToMarkdown(a.description),
          rubric: a.rubric?.map((r: Obj) =>
            compact({
              criterion: richTextToMarkdown(r.description),
              details: richTextToMarkdown(r.long_description),
              points: r.points,
              ratings: r.ratings?.map((x: Obj) => {
                const more = richTextToMarkdown(x.long_description);
                return `${x.points} pts: ${richTextToMarkdown(x.description) ?? ""}${more ? ` (${more})` : ""}`;
              }),
              your_points: marks[r.id]?.points,
              grader_comment: marks[r.id]?.comments,
            }),
          ),
          submission: sub
            ? compact({
                ...submissionSummary(sub),
                files: attachmentList(sub),
                comments: sub.submission_comments?.map((cm: Obj) =>
                  compact({ author: cm.author_name, at: cm.created_at, comment: cm.comment }),
                ),
              })
            : undefined,
        });
      }),
  );

  server.registerTool(
    "get_submission",
    {
      title: "Check my submission",
      description:
        "Check the user's submission for one assignment without its instructions: status, score, submitted files (name, size, upload status), attempts used and allowed, attempt history, and grader comments. For group assignments it also gives the group and who uploaded the files. Use it for \"have I submitted?\"; get_assignment has the full brief and rubric.",
      inputSchema: {
        course_id: courseId,
        assignment_id: z.coerce.string().describe("Assignment ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, assignment_id }) =>
      run(async () => {
        const c = canvas();
        const base = `courses/${course_id}/assignments/${assignment_id}`;
        const [a, sub] = await Promise.all([
          c.get<Obj>(base),
          c.get<Obj>(`${base}/submissions/self`, { include: ["submission_history", "submission_comments"] }),
        ]);
        const [group, by] = await Promise.all([
          assignmentGroup(c, a),
          a.group_category_id && sub.submitted_at ? uploadedBy(c, sub) : undefined,
        ]);
        const history: Obj[] = (sub.submission_history ?? [])
          .filter((h: Obj) => h.submitted_at)
          .sort((x: Obj, y: Obj) => Number(x.attempt) - Number(y.attempt));
        return compact({
          assignment: a.name,
          due_at: a.due_at,
          lock_at: a.lock_at,
          ...submissionSummary(sub),
          submission_type: sub.submission_type,
          attempts_allowed: a.allowed_attempts > 0 ? a.allowed_attempts : "unlimited",
          group: groupInfo(a, group),
          uploaded_by: by,
          files: attachmentList(sub),
          submitted_url: sub.submission_type === "online_url" ? sub.url : undefined,
          text: truncate(htmlToMarkdown(sub.body), 1000),
          history:
            history.length > 1
              ? history.map((h) =>
                  compact({
                    attempt: h.attempt,
                    submitted_at: h.submitted_at,
                    late: h.late || undefined,
                    score: h.score,
                    files: h.attachments?.map((f: Obj) => f.display_name),
                  }),
                )
              : undefined,
          comments: sub.submission_comments?.map((cm: Obj) =>
            compact({ author: cm.author_name, at: cm.created_at, comment: cm.comment }),
          ),
          url: a.html_url,
        });
      }),
  );

  server.registerTool(
    "list_announcements",
    {
      title: "List announcements",
      description: "List recent course announcements, newest first. Defaults to all active courses and the last 14 days.",
      inputSchema: {
        course_ids: z.array(z.coerce.string()).optional().describe("Course IDs to include (default: all active courses)"),
        days_back: z.number().int().min(1).max(365).optional().describe("How many days back to look (default 14)"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_ids, days_back }) =>
      run(async () => {
        const c = canvas();
        const ids = course_ids?.length ? course_ids : await activeCourseIds(c);
        if (!ids.length) return [];
        const now = Date.now();
        const items = await c.getAll<Obj>("announcements", {
          context_codes: ids.map((id) => `course_${id}`),
          start_date: new Date(now - (days_back ?? 14) * DAY_MS).toISOString(),
          end_date: new Date(now).toISOString(),
        });
        return items.map((a) =>
          compact({
            id: a.id,
            title: a.title,
            course_id: a.context_code?.replace(/^course_/, ""),
            posted_at: a.posted_at,
            author: a.author?.display_name ?? a.user_name,
            message: truncate(htmlToMarkdown(a.message), 3000),
            url: a.html_url,
          }),
        );
      }),
  );

  server.registerTool(
    "list_modules",
    {
      title: "List course modules",
      description:
        "List a course's modules and the items in each (pages, files, assignments, quizzes, discussions, links), with due dates and completion. Follow up with get_page (Page items, using page_url), get_file (File items, using content_id), or get_assignment (Assignment items, using content_id).",
      inputSchema: { course_id: courseId },
      annotations: READ_ONLY,
    },
    async ({ course_id }) =>
      run(async () => {
        const c = canvas();
        const modules = await c.getAll<Obj>(`courses/${course_id}/modules`, { include: ["items", "content_details"] });
        return Promise.all(
          modules.map(async (m) => {
            // Canvas omits inline items for large modules and gives items_url instead.
            const items: Obj[] =
              m.items ?? (m.items_url ? await c.getAll<Obj>(m.items_url, { include: ["content_details"] }) : []);
            return compact({
              id: m.id,
              name: m.name,
              state: m.state,
              unlock_at: m.unlock_at,
              items: items.map((it) =>
                compact({
                  title: it.title,
                  type: it.type,
                  content_id: it.content_id,
                  page_url: it.page_url,
                  external_url: it.external_url,
                  due_at: it.content_details?.due_at,
                  points_possible: it.content_details?.points_possible,
                  locked: it.content_details?.locked_for_user || undefined,
                  completed: it.completion_requirement?.completed,
                }),
              ),
            });
          }),
        );
      }),
  );

  server.registerTool(
    "list_pages",
    {
      title: "List course pages",
      description: "List a course's wiki pages. Use get_page with the returned url slug to read one.",
      inputSchema: {
        course_id: courseId,
        search: z.string().optional().describe("Filter by page title"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, search }) =>
      run(async () => {
        const pages = await canvas().getAll<Obj>(`courses/${course_id}/pages`, { sort: "title", search_term: search });
        return pages.map((p) =>
          compact({ slug: p.url, title: p.title, updated_at: p.updated_at, front_page: p.front_page || undefined }),
        );
      }),
  );

  server.registerTool(
    "get_page",
    {
      title: "Read a course page",
      description: "Read a course wiki page as Markdown. Pass the page slug (from list_pages or list_modules), or \"front_page\" for the course home page.",
      inputSchema: {
        course_id: courseId,
        page: z.string().describe('Page slug, e.g. "week-3-readings", or "front_page"'),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, page }) =>
      run(async () => {
        // Tolerate a full page URL being passed instead of the slug.
        const slug = page.split("/pages/").pop()!;
        const path =
          slug === "front_page" ? `courses/${course_id}/front_page` : `courses/${course_id}/pages/${encodeURIComponent(slug)}`;
        const p = await canvas().get<Obj>(path);
        return compact({
          title: p.title,
          slug: p.url,
          updated_at: p.updated_at,
          url: p.html_url,
          body: htmlToMarkdown(p.body),
        });
      }),
  );

  server.registerTool(
    "get_syllabus",
    {
      title: "Read course syllabus",
      description: "Read the course's Syllabus page as Markdown.",
      inputSchema: { course_id: courseId },
      annotations: READ_ONLY,
    },
    async ({ course_id }) =>
      run(async () => {
        const course = await canvas().get<Obj>(`courses/${course_id}`, { include: ["syllabus_body"] });
        return compact({
          course: course.name,
          syllabus:
            htmlToMarkdown(course.syllabus_body) ??
            "No syllabus text is posted. The syllabus may be a file; try list_files or list_modules.",
        });
      }),
  );

  server.registerTool(
    "list_files",
    {
      title: "List course files",
      description: "List files in a course, most recently updated first. Some courses hide the Files area from students; list_modules may still show files.",
      inputSchema: {
        course_id: courseId,
        search: z.string().min(2).optional().describe("Filter by file name (at least 2 characters)"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, search }) =>
      run(async () => {
        const files = await canvas().getAll<Obj>(`courses/${course_id}/files`, {
          search_term: search,
          sort: "updated_at",
          order: "desc",
        });
        return files.map((f) =>
          compact({
            id: f.id,
            name: f.display_name,
            type: f["content-type"],
            size: f.size,
            updated_at: f.updated_at,
            locked: f.locked_for_user || undefined,
          }),
        );
      }),
  );

  server.registerTool(
    "get_file",
    {
      title: "Get file info",
      description: "Get a file's metadata and a download link the user can open. Use read_file to read its contents.",
      inputSchema: { file_id: z.coerce.string().describe("File ID (from list_files, or content_id of a File module item)") },
      annotations: READ_ONLY,
    },
    async ({ file_id }) =>
      run(async () => {
        const f = await canvas().get<Obj>(`files/${file_id}`);
        return compact({
          id: f.id,
          name: f.display_name,
          type: f["content-type"],
          size: f.size,
          created_at: f.created_at,
          updated_at: f.updated_at,
          locked: f.locked_for_user || undefined,
          lock_explanation: f.lock_explanation,
          download_url: f.url,
        });
      }),
  );

  server.registerTool(
    "get_grades",
    {
      title: "Get grades for a course",
      description:
        "Get the user's overall grade in a course plus every assignment's score, grouped by assignment group with group weights. current_score counts only graded work; final_score counts ungraded work as zero.",
      inputSchema: { course_id: courseId },
      annotations: READ_ONLY,
    },
    async ({ course_id }) =>
      run(async () => {
        const c = canvas();
        const [course, groups] = await Promise.all([
          c.get<Obj>(`courses/${course_id}`, { include: ["total_scores"] }),
          c.getAll<Obj>(`courses/${course_id}/assignment_groups`, { include: ["assignments", "submission"] }),
        ]);
        const e = course.enrollments?.find((en: Obj) => en.type === "student") ?? course.enrollments?.[0];
        const weighted = Boolean(course.apply_assignment_group_weights);
        return compact({
          course: course.name,
          current_score: e?.computed_current_score,
          current_grade: e?.computed_current_grade,
          final_score: e?.computed_final_score,
          final_grade: e?.computed_final_grade,
          weighted_groups: weighted,
          groups: groups.map((g) =>
            compact({
              name: g.name,
              weight_percent: weighted ? g.group_weight : undefined,
              assignments: (g.assignments ?? []).map((a: Obj) =>
                compact({
                  id: a.id,
                  name: a.name,
                  due_at: a.due_at,
                  points_possible: a.points_possible,
                  ...submissionSummary(a.submission),
                }),
              ),
            }),
          ),
        });
      }),
  );

  server.registerTool(
    "list_discussions",
    {
      title: "List discussion topics",
      description: "List a course's discussion topics, most recently active first, with reply and unread counts.",
      inputSchema: {
        course_id: courseId,
        search: z.string().optional().describe("Filter by title"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, search }) =>
      run(async () => {
        const topics = await canvas().getAll<Obj>(`courses/${course_id}/discussion_topics`, {
          order_by: "recent_activity",
          search_term: search,
        });
        return topics.map((t) =>
          compact({
            id: t.id,
            title: t.title,
            posted_at: t.posted_at,
            last_reply_at: t.last_reply_at,
            replies: t.discussion_subentry_count,
            unread: t.unread_count || undefined,
            assignment_id: t.assignment_id,
            pinned: t.pinned || undefined,
            url: t.html_url,
          }),
        );
      }),
  );

  server.registerTool(
    "get_discussion",
    {
      title: "Read a discussion",
      description: "Read a discussion topic's prompt and its full reply thread as Markdown.",
      inputSchema: {
        course_id: courseId,
        topic_id: z.coerce.string().describe("Discussion topic ID"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, topic_id }) =>
      run(async () => {
        const c = canvas();
        const base = `courses/${course_id}/discussion_topics/${topic_id}`;
        const [topic, view] = await Promise.all([
          c.get<Obj>(base),
          // Fails for "post before seeing replies" topics until the user has posted.
          c.get<Obj>(`${base}/view`).catch((err: Error): Obj => ({ error: err.message })),
        ]);
        const names = new Map<string, string>(
          (view.participants ?? []).map((p: Obj) => [String(p.id), p.display_name]),
        );
        const entry = (e: Obj): Obj =>
          compact({
            author: names.get(String(e.user_id)) ?? e.user_name,
            at: e.created_at,
            message: e.deleted ? "[deleted]" : htmlToMarkdown(e.message),
            replies: e.replies?.map(entry),
          });
        return compact({
          title: topic.title,
          author: topic.author?.display_name,
          posted_at: topic.posted_at,
          url: topic.html_url,
          assignment_id: topic.assignment_id,
          prompt: htmlToMarkdown(topic.message),
          entries: view.view?.map(entry),
          entries_unavailable: view.error,
        });
      }),
  );

  server.registerTool(
    "canvas_api_get",
    {
      title: "Raw Canvas API GET",
      description:
        "Read-only GET against any Canvas REST API endpoint for things the other tools don't cover (see https://canvas.instructure.com/doc/api/). The path is relative to /api/v1, e.g. \"courses/123/quizzes\", \"users/self/groups\", \"conversations\". Returns raw JSON.",
      inputSchema: {
        path: z.string().describe('Endpoint path relative to /api/v1, e.g. "courses/123/quizzes"'),
        params: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]))
          .optional()
          .describe('Query parameters; arrays become key[]=value, e.g. {"include": ["submission"]}'),
        all_pages: z.boolean().optional().describe("Follow pagination and return every item (list endpoints only)"),
      },
      annotations: READ_ONLY,
    },
    async ({ path, params, all_pages }) =>
      run(async () => (all_pages ? canvas().getAll(path, params) : canvas().get(path, params))),
  );
}
