// Calendar, inbox, recent activity, course people and groups (all read-only).
import { z } from "zod";
import { compact, htmlToMarkdown, truncate } from "../format.js";
import { DAY_MS, READ_ONLY, activeCourseIds, courseId, resolveRange, type Obj, type ToolContext } from "./shared.js";

// Canvas rejects calendar_events requests with more than 10 context codes.
const CONTEXTS_PER_REQUEST = 10;

export function registerCommunityTools({ server, canvas, run }: ToolContext): void {
  server.registerTool(
    "list_calendar_events",
    {
      title: "List calendar events",
      description:
        "List Canvas calendar events (classes, tutorials, exams, office hours, personal events) in a date range, across all active courses plus the user's own calendar. Assignment due dates are in get_planner instead. Note that many universities keep lecture timetables outside Canvas. Defaults to today through the next 7 days.",
      inputSchema: {
        start_date: z.string().optional().describe("Date (whole day, user's time zone) or ISO datetime. Default: today."),
        end_date: z.string().optional().describe("Date (inclusive) or ISO datetime. Default: 7 days after start_date."),
        course_ids: z.array(z.coerce.string()).optional().describe("Limit to these courses (default: all active)"),
      },
      annotations: READ_ONLY,
    },
    async ({ start_date, end_date, course_ids }) =>
      run(async () => {
        const c = canvas();
        const [{ start, end }, ids, me] = await Promise.all([
          resolveRange(c, start_date, end_date, 7),
          course_ids?.length ? course_ids : activeCourseIds(c),
          c.get<Obj>("users/self"),
        ]);
        const contexts = [...ids.map((id) => `course_${id}`), ...(course_ids?.length ? [] : [`user_${me.id}`])];
        const batches: string[][] = [];
        for (let i = 0; i < contexts.length; i += CONTEXTS_PER_REQUEST) {
          batches.push(contexts.slice(i, i + CONTEXTS_PER_REQUEST));
        }
        const results = await Promise.all(
          batches.map((codes) =>
            c.getAll<Obj>("calendar_events", {
              type: "event",
              context_codes: codes,
              start_date: start.toISOString(),
              end_date: end.toISOString(),
            }),
          ),
        );
        return results
          .flat()
          .sort((a, b) => String(a.start_at).localeCompare(String(b.start_at)))
          .map((e) =>
            compact({
              id: e.id,
              title: e.title,
              start_at: e.start_at,
              end_at: e.end_at,
              all_day: e.all_day || undefined,
              location: [e.location_name, e.location_address].filter(Boolean).join(", "),
              calendar: e.context_name,
              description: truncate(htmlToMarkdown(e.description), 1000),
              url: e.html_url,
            }),
          );
      }),
  );

  server.registerTool(
    "list_conversations",
    {
      title: "List inbox messages",
      description:
        "List Canvas Inbox conversations (direct messages from instructors, tutors and classmates), newest first. Reading them here does not mark them as read.",
      inputSchema: {
        scope: z
          .enum(["inbox", "unread", "starred", "sent", "archived"])
          .optional()
          .describe("Which folder (default inbox)"),
        course_id: courseId.optional().describe("Only conversations in this course"),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum conversations (default 30)"),
      },
      annotations: READ_ONLY,
    },
    async ({ scope, course_id, limit }) =>
      run(async () => {
        const conversations = await canvas().getAll<Obj>(
          "conversations",
          { scope: scope === "inbox" ? undefined : scope, filter: course_id ? [`course_${course_id}`] : undefined },
          limit ?? 30,
        );
        return conversations.map((cv) =>
          compact({
            id: cv.id,
            subject: cv.subject || "(no subject)",
            course: cv.context_name,
            last_message_at: cv.last_message_at,
            last_message: truncate(cv.last_message, 300),
            unread: cv.workflow_state === "unread" || undefined,
            starred: cv.starred || undefined,
            messages: cv.message_count,
            participants: cv.participants?.map((p: Obj) => p.name),
          }),
        );
      }),
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Read an inbox conversation",
      description:
        "Read every message in a Canvas Inbox conversation, oldest first, with attachment file IDs (readable with read_file). Does not mark it as read.",
      inputSchema: { conversation_id: z.coerce.string().describe("Conversation ID (from list_conversations)") },
      annotations: READ_ONLY,
    },
    async ({ conversation_id }) =>
      run(async () => {
        const cv = await canvas().get<Obj>(`conversations/${conversation_id}`, { auto_mark_as_read: false });
        const names = new Map<string, string>((cv.participants ?? []).map((p: Obj) => [String(p.id), p.name]));
        return compact({
          id: cv.id,
          subject: cv.subject || "(no subject)",
          course: cv.context_name,
          participants: cv.participants?.map((p: Obj) => compact({ id: p.id, name: p.name })),
          messages: [...(cv.messages ?? [])].reverse().map((m: Obj) =>
            compact({
              author: names.get(String(m.author_id)) ?? m.author_id,
              at: m.created_at,
              body: m.body,
              attachments: m.attachments?.map((a: Obj) => compact({ file_id: a.id, name: a.display_name })),
            }),
          ),
        });
      }),
  );

  server.registerTool(
    "get_recent_activity",
    {
      title: "Recent activity",
      description:
        "What's new across active courses: announcements, discussion posts, inbox messages, newly graded submissions and other updates, newest first. Good for \"what did I miss?\".",
      inputSchema: {
        days: z.number().int().min(1).max(60).optional().describe("How many days back (default 7)"),
        unread_only: z.boolean().optional().describe("Only items not yet read"),
      },
      annotations: READ_ONLY,
    },
    async ({ days, unread_only }) =>
      run(async () => {
        const since = Date.now() - (days ?? 7) * DAY_MS;
        const items = await canvas().getAll<Obj>("users/self/activity_stream", { only_active_courses: true }, 200);
        return items
          .filter((it) => new Date(it.updated_at).getTime() >= since)
          .filter((it) => !unread_only || it.read_state === false)
          .map((it) =>
            compact({
              type: it.type,
              title: it.title ?? it.assignment?.name,
              course_id: it.course_id,
              updated_at: it.updated_at,
              unread: it.read_state === false || undefined,
              score: it.type === "Submission" ? it.score : undefined,
              grade: it.type === "Submission" ? it.grade : undefined,
              points_possible: it.type === "Submission" ? it.assignment?.points_possible : undefined,
              summary: truncate(htmlToMarkdown(it.message), 400),
              url: it.html_url,
            }),
          );
      }),
  );

  server.registerTool(
    "list_course_people",
    {
      title: "List course staff or classmates",
      description:
        "List people in a course with their Canvas user IDs (usable as message recipients) and emails where visible. Defaults to teaching staff (teachers and TAs); search by name to find specific students.",
      inputSchema: {
        course_id: courseId,
        roles: z
          .array(z.enum(["teacher", "ta", "student", "designer", "observer"]))
          .optional()
          .describe('Roles to include (default ["teacher", "ta"])'),
        search: z.string().min(2).optional().describe("Filter by name (at least 2 characters)"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, roles, search }) =>
      run(async () => {
        const people = await canvas().getAll<Obj>(
          `courses/${course_id}/users`,
          { enrollment_type: roles ?? ["teacher", "ta"], include: ["email", "enrollments"], search_term: search },
          200,
        );
        return people.map((p) =>
          compact({
            id: p.id,
            name: p.name,
            email: p.email,
            roles: [...new Set((p.enrollments ?? []).map((e: Obj) => String(e.type).replace(/Enrollment$/, "")))],
          }),
        );
      }),
  );

  server.registerTool(
    "list_my_groups",
    {
      title: "List my groups",
      description:
        "List the user's Canvas groups (e.g. project teams) in current courses, or in one course, with their members and user IDs.",
      inputSchema: {
        course_id: courseId.optional().describe("Only groups in this course"),
        include_past: z.boolean().optional().describe("Also include groups from past courses"),
      },
      annotations: READ_ONLY,
    },
    async ({ course_id, include_past }) =>
      run(async () => {
        const c = canvas();
        const [groups, active] = await Promise.all([
          c.getAll<Obj>("users/self/groups"),
          include_past || course_id ? undefined : activeCourseIds(c),
        ]);
        const current = course_id
          ? groups.filter((g) => String(g.course_id) === course_id)
          : active
            ? groups.filter((g) => active.includes(String(g.course_id)))
            : groups;
        return Promise.all(
          current.map(async (g) => {
            const members = await c.getAll<Obj>(`groups/${g.id}/users`, {}, 100).catch(() => undefined);
            return compact({
              id: g.id,
              name: g.name?.trim(),
              course_id: g.course_id,
              category: g.group_category?.name,
              member_count: g.members_count,
              members: members?.map((m) => compact({ id: m.id, name: m.name })),
            });
          }),
        );
      }),
  );
}
