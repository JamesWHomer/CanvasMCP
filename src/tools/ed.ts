// Ed Discussion (the course forum on edstem.org) and Ed Lessons, reached through the courses' Ed tool in Canvas.
// ed_post_thread and ed_reply are registered only with the other write tools, and are two-step like them.
import { z } from "zod";
import { ed, edTime, type EdClient } from "../ed.js";
import { edToMarkdown, markdownToEd } from "../edxml.js";
import { compact } from "../format.js";
import { READ_ONLY, type Obj, type ToolContext } from "./shared.js";
import { OUTWARD, confirm } from "./write.js";

const DEFAULT_THREADS = 30;
const DEFAULT_REPLIES = 50;
const DEFAULT_CHARS = 40_000;
const PREVIEW_CHARS = 200;
const MAX_SUBCATEGORIES = 8;
// Ed's names for the list filters: "unread" is threads never opened, "new" is opened threads with new replies.
const FILTERS = {
  unread: "unread",
  new_replies: "new",
  unanswered: "unanswered",
  unresolved: "unresolved",
  mine: "mine",
  watching: "watching",
  starred: "starred",
} as const;

// Ed IDs go into API paths, so only digits are accepted.
const edId = (name: string) => z.coerce.string().regex(/^\d+$/, `${name} must be a number`);
const edCourseId = edId("ed_course_id").describe("Ed course ID (from ed_list_courses; not the Canvas course ID)");
const markdownBody = z
  .string()
  .min(1)
  .describe(
    "Text in Markdown: paragraphs, # headings, - or 1. lists, > quotes, ``` code blocks ```, **bold**, *italic*, `code` and [links](url)",
  );

/** "Name", "Name (staff)" or "Anonymous". Ed's course roles are admin and staff (teaching staff), mentor and student. */
function who(user: Obj | undefined, anonymous: boolean): string {
  if (anonymous) return "Anonymous";
  if (!user) return "Unknown";
  const role = user.course_role;
  if (!role || role === "student") return user.name;
  return `${user.name} (${role === "mentor" ? "mentor" : "staff"})`;
}

const categoryPath = (t: Obj) => [t.category, t.subcategory, t.subsubcategory].filter(Boolean).join(" › ");

/** A course's discussion categories, e.g. "Projects (P1, P2)"; long subcategory lists are cut short unless `all`. */
function categoryList(course: Obj, all = false): string[] {
  return (course.settings?.discussion?.categories ?? []).map((cat: Obj) => {
    const subs: string[] = (cat.subcategories ?? []).map((s: Obj) => s.name);
    if (!subs.length) return cat.name;
    const shown = all || subs.length <= MAX_SUBCATEGORIES ? subs : [...subs.slice(0, MAX_SUBCATEGORIES), `${subs.length - MAX_SUBCATEGORIES} more`];
    return `${cat.name} (${shown.join(", ")})`;
  });
}

/** Up to `max` characters, ending in "…" when cut. */
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).trimEnd()}…` : text);

async function enrolments(e: EdClient): Promise<{ course: Obj; role?: Obj; last_active?: string }[]> {
  const user = await e.get<Obj>("user");
  return user.courses ?? [];
}

async function enrolment(e: EdClient, courseId: string): Promise<{ course: Obj; role: string }> {
  const entry = (await enrolments(e)).find((x) => String(x.course?.id) === courseId);
  if (!entry) throw new Error(`You're not in Ed course ${courseId}; ed_list_courses lists your Ed courses.`);
  return { course: entry.course, role: entry.role?.role ?? "student" };
}

function answered(t: Obj): string | undefined {
  if (t.type !== "question") return undefined;
  if (t.is_staff_answered) return "by staff";
  if (t.is_student_answered) return "by a student";
  return t.is_answered ? "yes" : "no";
}

async function threadSummary(e: EdClient, t: Obj, course?: string) {
  return compact({
    thread_id: t.id,
    number: t.number,
    course,
    type: t.type,
    title: t.title,
    category: categoryPath(t),
    author: who(t.user, t.is_anonymous),
    created_at: edTime(t.created_at),
    replies: t.reply_count,
    unread: t.is_seen === false || undefined,
    new_replies: t.new_reply_count || undefined,
    answered: answered(t),
    pinned: t.is_pinned || undefined,
    private: t.is_private || undefined,
    endorsed: t.is_endorsed || undefined,
    locked: t.is_locked || undefined,
    votes: t.vote_count || undefined,
    preview: clip(String(t.document ?? "").replace(/\s+/g, " ").trim(), PREVIEW_CHARS),
    url: await e.link(`courses/${t.course_id}/discussion/${t.id}`),
  });
}

function lessonSummary(l: Obj, url: string) {
  return compact({
    lesson_id: l.id,
    title: l.title,
    kind: l.kind,
    slides: l.slide_count,
    status: l.status,
    state: l.state === "active" ? undefined : l.state,
    available_at: edTime(l.effective_available_at ?? l.available_at),
    due_at: edTime(l.effective_due_at ?? l.due_at),
    locked_at: edTime(l.effective_locked_at ?? l.locked_at),
    submitted_at: edTime(l.submitted_at),
    timed: l.is_timed || undefined,
    attempts_remaining: l.attempts_remaining ?? undefined,
    url,
  });
}

/** A quiz slide's questions with their options (never solutions). */
function quizText(questions: Obj[] | undefined): string {
  if (!questions?.length) return "(quiz: open it in Ed to see the questions)";
  return [...questions]
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    .map((q, n) => {
      const d = q.data ?? {};
      const options = (d.answers ?? []).map(
        (a: string, i: number) => `- ${String.fromCharCode(65 + i)}. ${edToMarkdown(a)?.replace(/\s*\n+\s*/g, " ") ?? ""}`,
      );
      return [`**Question ${n + 1}** (${d.type ?? "question"})`, edToMarkdown(d.content), options.join("\n")]
        .filter(Boolean)
        .join("\n\n");
    })
    .join("\n\n");
}

function findComment(comments: Obj[], id: string): Obj | undefined {
  for (const c of comments) {
    if (String(c.id) === id) return c;
    const nested = findComment(c.comments ?? [], id);
    if (nested) return nested;
  }
  return undefined;
}

export function registerEdTools({ server, canvas, run }: ToolContext): void {
  server.registerTool(
    "ed_list_courses",
    {
      title: "List Ed courses",
      description:
        "List the user's courses in Ed (edstem.org: the Ed Discussion forum and Ed Lessons), with the ed_course_id the other ed_ tools need and each course's discussion categories. Ed course IDs are not Canvas course IDs; match courses by code or name. Ed is signed in to through the Ed Discussion tab in Canvas, so no Ed password is needed.",
      inputSchema: { include_archived: z.boolean().optional().describe("Also list past (archived) courses") },
      annotations: READ_ONLY,
    },
    async ({ include_archived }) =>
      run(async () => {
        const e = ed(canvas());
        const courses = (await enrolments(e)).filter((x) => include_archived || x.course?.status === "active");
        // Most recently used first.
        courses.sort((a, b) => (Date.parse(b.last_active ?? "") || 0) - (Date.parse(a.last_active ?? "") || 0));
        return Promise.all(
          courses.map(async ({ course, role, last_active }) =>
            compact({
              ed_course_id: String(course.id),
              code: course.code,
              name: course.name,
              session: [course.session, course.year].filter(Boolean).join(" "),
              status: course.status === "active" ? undefined : course.status,
              role: role?.role,
              last_active: edTime(last_active),
              lessons: course.features?.lessons === false ? false : undefined,
              categories: categoryList(course),
              url: await e.link(`courses/${course.id}/discussion`),
            }),
          ),
        );
      }),
  );

  server.registerTool(
    "ed_list_threads",
    {
      title: "List Ed Discussion threads",
      description:
        'List or search threads (questions, posts, announcements) in a course\'s Ed Discussion forum, pinned first then newest; a query searches titles and posts. Without ed_course_id it covers every active Ed course, newest first: e.g. filter "unread" for what\'s new on Ed. Filters: "unread" (never opened), "new_replies" (opened, with replies since), "unanswered", "unresolved", "mine", "watching", "starred". Read a thread\'s replies with ed_get_thread. Listing doesn\'t mark anything as read.',
      inputSchema: {
        ed_course_id: edCourseId.optional(),
        query: z.string().optional().describe("Search text"),
        filter: z
          .enum(Object.keys(FILTERS) as [keyof typeof FILTERS, ...(keyof typeof FILTERS)[]])
          .optional()
          .describe("Only these threads (see the description)"),
        category: z.string().optional().describe("Only this category (names from ed_list_courses)"),
        sort: z
          .enum(["new", "top"])
          .optional()
          .describe('"new" (default; searches are ranked by relevance unless a sort is given) or "top" (most votes)'),
        limit: z.number().int().min(1).max(100).optional().describe(`Maximum threads (default ${DEFAULT_THREADS})`),
        offset: z.number().int().min(0).optional().describe("Skip this many threads (with ed_course_id; for paging)"),
      },
      annotations: READ_ONLY,
    },
    async ({ ed_course_id, query, filter, category, sort, limit = DEFAULT_THREADS, offset = 0 }) =>
      run(async () => {
        const e = ed(canvas());
        const search = query?.trim();
        const votes = (t: Obj) => t.vote_count ?? 0;
        const time = (t: Obj) => Date.parse(t.created_at) || 0;
        // The thread list ignores search text; searches go to their own endpoint, ranked by relevance by default.
        const fetchThreads = async (courseId: string): Promise<{ threads: Obj[]; total?: number }> => {
          const common = { filter: filter && FILTERS[filter], category, limit, offset };
          if (!search) {
            const data = await e.get<Obj>(`courses/${courseId}/threads`, { ...common, sort: sort ?? "new" });
            return { threads: data.threads ?? [] };
          }
          const data = await e.get<Obj>(`courses/${courseId}/threads/search`, {
            ...common,
            query: search,
            sort: sort === "new" ? "new" : undefined,
          });
          const threads: Obj[] = data.threads ?? [];
          if (sort === "top") threads.sort((a, b) => votes(b) - votes(a));
          return { threads, total: data.total };
        };

        if (ed_course_id) {
          const { threads, total } = await fetchThreads(ed_course_id);
          const end = offset + threads.length;
          const more = total === undefined ? threads.length === limit : end < total;
          return compact({
            total,
            count: threads.length,
            next_offset: more ? end : undefined,
            threads: await Promise.all(threads.map((t) => threadSummary(e, t))),
          });
        }
        if (offset) throw new Error("offset only works with ed_course_id");
        const courses = (await enrolments(e)).filter((x) => x.course?.status === "active").map((x) => x.course);
        const lists = await Promise.all(
          courses.map(async (course) =>
            (await fetchThreads(String(course.id))).threads.map((t) => ({ t, course: course.code as string })),
          ),
        );
        const merged = lists
          .flat()
          .sort((a, b) => (sort === "top" ? votes(b.t) - votes(a.t) : 0) || time(b.t) - time(a.t))
          .slice(0, limit);
        const threads = await Promise.all(merged.map(({ t, course }) => threadSummary(e, t, course)));
        return { courses: courses.length, count: threads.length, threads };
      }),
  );

  server.registerTool(
    "ed_get_thread",
    {
      title: "Read an Ed Discussion thread",
      description:
        "Read an Ed Discussion thread in full: the post as Markdown, then its answers (accepted first) and comments, each with nested replies, authors and whether staff endorsed it. Give thread_id (from ed_list_threads), or ed_course_id plus the thread's number (the #123 shown in Ed). Images and attachments come back as links. Threads with many replies are paged with offset. Doesn't mark the thread as read.",
      inputSchema: {
        thread_id: edId("thread_id").optional().describe("Thread ID from ed_list_threads"),
        ed_course_id: edCourseId.optional().describe("The Ed course, when giving number instead of thread_id"),
        number: z.coerce.number().int().positive().optional().describe("The thread's number in its course (#123)"),
        offset: z.number().int().min(0).optional().describe("Skip this many top-level replies (default 0)"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`Maximum top-level answers and comments (default ${DEFAULT_REPLIES})`),
      },
      annotations: READ_ONLY,
    },
    async ({ thread_id, ed_course_id, number, offset = 0, limit = DEFAULT_REPLIES }) =>
      run(async () => {
        const e = ed(canvas());
        let path: string;
        if (thread_id) path = `threads/${thread_id}`;
        else if (ed_course_id && number) path = `courses/${ed_course_id}/threads/${number}`;
        else throw new Error("Give thread_id, or ed_course_id and number");
        const data = await e.get<Obj>(path);
        const t = data.thread;
        const users = new Map<number, Obj>((data.users ?? []).map((u: Obj) => [u.id, u]));
        const reply = (c: Obj): Obj =>
          compact({
            comment_id: c.id,
            type: c.type,
            author: who(users.get(c.user_id), c.is_anonymous),
            created_at: edTime(c.created_at),
            accepted: c.id === t.accepted_id || undefined,
            endorsed: c.is_endorsed || undefined,
            private: c.is_private || undefined,
            votes: c.vote_count || undefined,
            body: edToMarkdown(c.content),
            replies: (c.comments ?? []).map(reply),
          });
        const answers = [...(t.answers ?? [])].sort(
          (a: Obj, b: Obj) => Number(b.id === t.accepted_id) - Number(a.id === t.accepted_id),
        );
        const all = [...answers, ...(t.comments ?? [])];
        const page = all.slice(offset, offset + limit);
        return compact({
          thread_id: t.id,
          number: t.number,
          ed_course_id: String(t.course_id),
          type: t.type,
          title: t.title,
          category: categoryPath(t),
          author: who(users.get(t.user_id), t.is_anonymous),
          created_at: edTime(t.created_at),
          answered: answered(t),
          pinned: t.is_pinned || undefined,
          private: t.is_private || undefined,
          locked: t.is_locked || undefined,
          endorsed: t.is_endorsed || undefined,
          duplicate_of: t.duplicate_id ?? undefined,
          votes: t.vote_count || undefined,
          views: t.unique_view_count,
          body: edToMarkdown(t.content),
          total_replies: all.length,
          offset: offset || undefined,
          next_offset: offset + page.length < all.length ? offset + page.length : undefined,
          replies: page.map(reply),
          url: await e.link(`courses/${t.course_id}/discussion/${t.id}`),
        });
      }),
  );

  server.registerTool(
    "ed_list_lessons",
    {
      title: "List Ed Lessons",
      description:
        "List a course's Ed Lessons (tutorial sheets, readings, quizzes and coding challenges in Ed), grouped by module, with the user's progress and any due dates. Read one with ed_get_lesson.",
      inputSchema: { ed_course_id: edCourseId },
      annotations: READ_ONLY,
    },
    async ({ ed_course_id }) =>
      run(async () => {
        const e = ed(canvas());
        const data = await e.get<Obj>(`courses/${ed_course_id}/lessons`);
        const modules = new Map<number, { module: string; lessons: Obj[] }>(
          (data.modules ?? []).map((m: Obj) => [m.id, { module: m.name, lessons: [] }]),
        );
        const other: Obj[] = [];
        // Ed's own order where it has one, otherwise by title so "Week 2" comes before "Week 10".
        const lessons = [...(data.lessons ?? [])].sort(
          (a: Obj, b: Obj) =>
            (a.index ?? Infinity) - (b.index ?? Infinity) ||
            String(a.title).localeCompare(String(b.title), undefined, { numeric: true }),
        );
        for (const l of lessons) {
          const summary = lessonSummary(l, await e.link(`courses/${ed_course_id}/lessons/${l.id}`));
          (modules.get(l.module_id)?.lessons ?? other).push(summary);
        }
        const grouped = [...modules.values()].filter((m) => m.lessons.length);
        return compact({
          count: lessons.length,
          modules: grouped,
          // Lessons outside any module; when there are no modules, that's all of them.
          [grouped.length ? "other_lessons" : "lessons"]: other,
        });
      }),
  );

  server.registerTool(
    "ed_get_lesson",
    {
      title: "Read an Ed lesson",
      description:
        "Read an Ed lesson's slides as Markdown: reading slides in full, quiz slides as their questions and options, and coding challenges as their task description. Get lesson IDs from ed_list_lessons. Long lessons are paged: call again with next_offset to continue. Doesn't mark anything as viewed.",
      inputSchema: {
        lesson_id: edId("lesson_id").describe("Lesson ID from ed_list_lessons"),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)"),
        max_chars: z
          .number()
          .int()
          .min(1000)
          .max(100_000)
          .optional()
          .describe(`Maximum characters to return (default ${DEFAULT_CHARS})`),
      },
      annotations: READ_ONLY,
    },
    async ({ lesson_id, offset = 0, max_chars = DEFAULT_CHARS }) =>
      run(async () => {
        const e = ed(canvas());
        const { lesson } = await e.get<Obj>(`lessons/${lesson_id}`);
        const slides: Obj[] = (lesson.slides ?? []).filter((s: Obj) => !s.is_hidden);
        const questions = await Promise.all(
          slides.map((s) =>
            s.type === "quiz"
              ? e.get<Obj>(`lessons/slides/${s.id}/questions`).then(
                  (d) => d.questions as Obj[],
                  () => undefined,
                )
              : undefined,
          ),
        );
        const sections = slides.map((s, i) => {
          const status = s.status ? `, ${s.status}` : "";
          let body = s.type === "quiz" ? quizText(questions[i]) : (edToMarkdown(s.content) ?? `(${s.type} slide: open it in Ed)`);
          if (s.type === "code") body += "\n\n(Coding challenge: write and run the code in Ed.)";
          return `## ${i + 1}. ${s.title?.trim() || "Untitled"} (${s.type}${status})\n\n${body}`;
        });
        const full = sections.join("\n\n");
        const text = full.slice(offset, offset + max_chars);
        const end = offset + text.length;
        return compact({
          lesson_id: lesson.id,
          title: lesson.title,
          slides: slides.length,
          status: lesson.status,
          due_at: edTime(lesson.effective_due_at ?? lesson.due_at),
          total_chars: full.length,
          offset: offset || undefined,
          next_offset: end < full.length ? end : undefined,
          text: text || (offset >= full.length ? "[offset is past the end of the lesson]" : text),
          url: await e.link(`courses/${lesson.course_id}/lessons/${lesson.id}`),
        });
      }),
  );
}

export function registerEdWriteTools({ server, canvas, run }: ToolContext): void {
  server.registerTool(
    "ed_post_thread",
    {
      title: "Post a thread on Ed Discussion",
      description:
        "Start a new thread (a question or a post) in a course's Ed Discussion forum. ALWAYS two steps: call without confirm for a preview, show it to the user, then call again with confirm: true once they approve. Choose a category from ed_list_courses.",
      inputSchema: {
        ed_course_id: edCourseId,
        title: z.string().min(1).describe("Thread title"),
        body: markdownBody,
        type: z.enum(["question", "post"]).optional().describe('"question" (default) or "post"'),
        category: z.string().optional().describe("Category name (required when the course has categories)"),
        subcategory: z.string().optional().describe("Subcategory name within the category"),
        private: z.boolean().optional().describe("Only course staff can see it"),
        anonymous: z.boolean().optional().describe("Hide the user's name from other students"),
        confirm,
      },
      annotations: OUTWARD,
    },
    async ({ ed_course_id, title, body, type = "question", category, subcategory, private: priv, anonymous, confirm }) =>
      run(async () => {
        const e = ed(canvas());
        const { course, role } = await enrolment(e, ed_course_id);
        const d: Obj = course.settings?.discussion ?? {};
        if (d.readonly && role === "student") throw new Error(`${course.code}'s Ed Discussion is read-only for students.`);

        const categories: Obj[] = d.categories ?? [];
        const named = (list: Obj[] | undefined, name: string) =>
          list?.find((x) => String(x.name).toLowerCase() === name.trim().toLowerCase());
        let cat: Obj | undefined;
        if (category) {
          cat = named(categories, category);
          if (!cat) throw new Error(`${course.code} has no category "${category}". Categories: ${categoryList(course, true).join("; ")}`);
        } else if (categories.length) {
          throw new Error(`Choose a category. ${course.code}'s categories: ${categoryList(course, true).join("; ")}`);
        }
        let sub: Obj | undefined;
        if (subcategory) {
          sub = named(cat?.subcategories, subcategory);
          if (!sub) throw new Error(`"${cat?.name ?? category}" has no subcategory "${subcategory}"`);
        }

        const notes: string[] = [];
        let isPrivate = Boolean(priv);
        if (d.private_threads_only && !isPrivate) {
          isPrivate = true;
          notes.push("This course only allows private threads, so it will be private.");
        }
        if (isPrivate && d.private === false) throw new Error(`${course.code} doesn't allow private threads.`);
        if (anonymous && !d.anonymous) throw new Error(`${course.code} doesn't allow anonymous posts.`);
        if (d.threads_require_approval) notes.push("Staff approve new threads before others can see them.");
        if (cat?.subcategories?.length && !sub) {
          notes.push(`"${cat.name}" has subcategories (${cat.subcategories.map((s: Obj) => s.name).join(", ")}); none chosen.`);
        }

        if (!confirm) {
          return compact({
            status: "PREVIEW: nothing has been posted yet",
            course: `${course.code} ${course.name}`,
            type,
            category: [cat?.name, sub?.name].filter(Boolean).join(" › "),
            title,
            body,
            visible_to: isPrivate ? "only the user and course staff (private)" : `everyone in ${course.code}`,
            shown_as: anonymous
              ? d.anonymous_to_staff
                ? "Anonymous, to everyone including staff"
                : "Anonymous to other students; staff can still see the user's name"
              : "the user's name",
            notes,
            next_step: "Show this preview to the user. Only if they approve, call again with confirm: true.",
          });
        }
        const data = await e.post<Obj>(`courses/${ed_course_id}/threads`, {
          thread: {
            type,
            title,
            category: cat?.name ?? "",
            subcategory: sub?.name ?? "",
            subsubcategory: "",
            content: markdownToEd(body),
            is_pinned: false,
            is_private: isPrivate,
            is_anonymous: Boolean(anonymous),
            is_megathread: false,
            anonymous_comments: false,
          },
        });
        const t = data.thread;
        return compact({
          status: "POSTED",
          thread_id: t?.id,
          number: t?.number,
          awaiting_approval: t?.approved_status && t.approved_status !== "approved" ? true : undefined,
          url: t ? await e.link(`courses/${ed_course_id}/discussion/${t.id}`) : undefined,
        });
      }),
  );

  server.registerTool(
    "ed_reply",
    {
      title: "Reply on Ed Discussion",
      description:
        "Reply to an Ed Discussion thread: a comment on the thread, an answer to a question (as_answer), or a reply under an existing answer or comment (reply_to_comment_id, from ed_get_thread). ALWAYS two steps: call without confirm for a preview, show it to the user, then call again with confirm: true once they approve.",
      inputSchema: {
        thread_id: edId("thread_id").describe("Thread ID from ed_list_threads or ed_get_thread"),
        body: markdownBody,
        reply_to_comment_id: edId("reply_to_comment_id")
          .optional()
          .describe("Reply under this answer or comment instead of the thread itself"),
        as_answer: z.boolean().optional().describe("Post as an answer rather than a comment (questions only, not under a comment)"),
        private: z.boolean().optional().describe("Only course staff (and the user) can see it"),
        anonymous: z.boolean().optional().describe("Hide the user's name from other students"),
        confirm,
      },
      annotations: OUTWARD,
    },
    async ({ thread_id, body, reply_to_comment_id, as_answer, private: priv, anonymous, confirm }) =>
      run(async () => {
        const e = ed(canvas());
        const data = await e.get<Obj>(`threads/${thread_id}`);
        const t = data.thread;
        if (t.is_locked) throw new Error(`"${t.title}" is locked, so it can't be replied to.`);
        if (as_answer && (t.type !== "question" || reply_to_comment_id)) {
          throw new Error("Only a question takes answers, and only directly under the question; post a comment instead.");
        }
        let parent: Obj | undefined;
        if (reply_to_comment_id) {
          parent = findComment([...(t.answers ?? []), ...(t.comments ?? [])], reply_to_comment_id);
          if (!parent) throw new Error(`Thread ${thread_id} has no answer or comment ${reply_to_comment_id}`);
        }
        if (!confirm) {
          const users = new Map<number, Obj>((data.users ?? []).map((u: Obj) => [u.id, u]));
          const quoted = parent && clip(String(parent.document ?? "").replace(/\s+/g, " ").trim(), 150);
          return compact({
            status: "PREVIEW: nothing has been posted yet",
            thread: `#${t.number} ${t.title}`,
            replying_to: parent ? `${who(users.get(parent.user_id), parent.is_anonymous)}'s ${parent.type}: "${quoted}"` : "the thread",
            posting_as: as_answer ? "an answer" : "a comment",
            visible_to: t.is_private
              ? "the thread is private: only its participants and course staff"
              : priv
                ? "only the user and course staff (private)"
                : "everyone in the course",
            shown_as: anonymous ? "Anonymous to other students (staff may still see the user's name)" : "the user's name",
            body,
            next_step: "Show this preview to the user. Only if they approve, call again with confirm: true.",
          });
        }
        const path = parent ? `comments/${parent.id}/comments` : `threads/${t.id}/comments`;
        const posted = await e.post<Obj>(path, {
          comment: {
            type: as_answer ? "answer" : "comment",
            content: markdownToEd(body),
            is_private: Boolean(priv),
            is_anonymous: Boolean(anonymous),
          },
        });
        return compact({
          status: "POSTED",
          comment_id: posted.comment?.id,
          thread: `#${t.number} ${t.title}`,
          url: await e.link(`courses/${t.course_id}/discussion/${t.id}`),
        });
      }),
  );
}
