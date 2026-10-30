// Tools that change things in Canvas. Registered only when CANVAS_ALLOW_WRITES is on.
// Anything other people see (submissions, discussion posts, messages) is two-step: a call without
// confirm: true only returns a preview, so the user can check it before it's sent.
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import type { UploadFile } from "../canvas.js";
import { compact, textToHtml, truncate } from "../format.js";
import { courseId, resolveRange, run, submissionSummary, type Obj, type ToolContext } from "./shared.js";

const OUTWARD = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;
const PERSONAL = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const MAX_UPLOAD_BYTES = 100_000_000;

const confirm = z
  .boolean()
  .optional()
  .describe("Leave unset first to get a preview. Set true only after the user has approved that preview.");

const CONTENT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".zip": "application/zip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".html": "text/html",
  ".htm": "text/html",
  ".csv": "text/csv",
  ".json": "application/json",
  ".ipynb": "application/x-ipynb+json",
  ".md": "text/markdown",
};

function contentTypeFor(name: string): string {
  const ext = extname(name).toLowerCase();
  return CONTENT_TYPES[ext] ?? (ext ? "text/plain" : "application/octet-stream");
}

const fileInput = z.object({
  name: z.string().optional().describe("File name including extension, e.g. report.pdf (required unless path is given)"),
  text: z.string().optional().describe("File contents as text, for text/code files"),
  base64: z.string().optional().describe("File contents, base64-encoded, for binary files"),
  path: z.string().optional().describe("Path to a file on the user's computer (local server only)"),
});

async function loadFiles(files: z.infer<typeof fileInput>[], allowLocalFiles: boolean): Promise<UploadFile[]> {
  return Promise.all(
    files.map(async (f) => {
      let bytes: Uint8Array<ArrayBuffer>;
      let name = f.name;
      if (f.path) {
        if (!allowLocalFiles) {
          throw new Error("path only works with the local Canvas server; pass the contents as text or base64 instead");
        }
        bytes = new Uint8Array(await readFile(f.path));
        name ??= basename(f.path);
      } else if (f.base64 !== undefined) {
        bytes = new Uint8Array(Buffer.from(f.base64, "base64"));
      } else if (f.text !== undefined) {
        bytes = new TextEncoder().encode(f.text);
      } else {
        throw new Error("Each file needs one of text, base64 or path");
      }
      if (!name) throw new Error("Each file needs a name");
      if (bytes.length === 0) throw new Error(`${name} is empty`);
      if (bytes.length > MAX_UPLOAD_BYTES) throw new Error(`${name} is over ${MAX_UPLOAD_BYTES / 1e6} MB`);
      return { name, bytes, contentType: contentTypeFor(name) };
    }),
  );
}

export function registerWriteTools({ server, canvas, allowLocalFiles }: ToolContext): void {
  server.registerTool(
    "submit_assignment",
    {
      title: "Submit an assignment",
      description:
        "Submit work for an assignment: text entry, a website URL, or file uploads. ALWAYS two steps: first call without confirm to get a preview (which also flags lateness, attempts left and allowed file types), show it to the user, and call again with the same arguments plus confirm: true only once they approve. Files can be given as text, base64" +
        (allowLocalFiles ? ", or a path on the user's computer." : "."),
      inputSchema: {
        course_id: courseId,
        assignment_id: z.coerce.string().describe("Assignment ID"),
        text: z.string().optional().describe("Text-entry submission body (plain text; paragraphs separated by blank lines)"),
        url: z.string().url().optional().describe("Website URL submission"),
        files: z.array(fileInput).optional().describe("Files to upload as the submission"),
        comment: z.string().optional().describe("Optional comment to the marker"),
        confirm,
      },
      annotations: OUTWARD,
    },
    async ({ course_id, assignment_id, text, url, files, comment, confirm }) =>
      run(async () => {
        const c = canvas();
        const kinds = [text !== undefined, url !== undefined, Boolean(files?.length)].filter(Boolean).length;
        if (kinds !== 1) throw new Error("Provide exactly one of text, url or files");
        const type = files?.length ? "online_upload" : url !== undefined ? "online_url" : "online_text_entry";

        const base = `courses/${course_id}/assignments/${assignment_id}`;
        const [a, current] = await Promise.all([
          c.get<Obj>(base),
          c.get<Obj>(`${base}/submissions/self`).catch(() => undefined),
        ]);
        const uploads = files?.length ? await loadFiles(files, allowLocalFiles) : [];

        const problems: string[] = [];
        const allowed: string[] = a.submission_types ?? [];
        if (!allowed.includes(type)) problems.push(`This assignment doesn't accept ${type}; it accepts: ${allowed.join(", ")}`);
        const extensions: string[] = (a.allowed_extensions ?? []).map((e: string) => e.toLowerCase());
        for (const u of uploads) {
          const ext = extname(u.name).slice(1).toLowerCase();
          if (extensions.length && !extensions.includes(ext)) {
            problems.push(`${u.name}: only ${extensions.map((e) => `.${e}`).join(", ")} files are accepted`);
          }
        }
        const now = Date.now();
        if (a.locked_for_user || (a.lock_at && new Date(a.lock_at).getTime() < now)) {
          problems.push(`The assignment is locked${a.lock_explanation ? `: ${a.lock_explanation}` : ""}`);
        }
        const used = Number(current?.attempt ?? 0);
        if (a.allowed_attempts > 0 && used >= a.allowed_attempts) {
          problems.push(`All ${a.allowed_attempts} allowed attempts have been used`);
        }
        if (problems.length) throw new Error(`Can't submit "${a.name}":\n- ${problems.join("\n- ")}`);

        const late = Boolean(a.due_at && new Date(a.due_at).getTime() < now);
        if (!confirm) {
          return compact({
            status: "PREVIEW: nothing has been submitted yet",
            assignment: a.name,
            due_at: a.due_at,
            will_be_late: late || undefined,
            attempt: `${used + 1} of ${a.allowed_attempts > 0 ? a.allowed_attempts : "unlimited"}`,
            replaces_existing_submission: current?.submitted_at ? submissionSummary(current) : undefined,
            submission_type: type,
            text: truncate(text, 1500),
            url,
            files: uploads.map((u) => `${u.name} (${u.contentType}, ${u.bytes.length.toLocaleString()} bytes)`),
            comment,
            next_step: "Show this preview to the user. Only if they approve, call again with confirm: true.",
          });
        }

        const fileIds = [];
        for (const u of uploads) fileIds.push(await c.uploadSubmissionFile(course_id, assignment_id, u));
        const submission = await c.post<Obj>(`${base}/submissions`, {
          submission: compact({
            submission_type: type,
            body: text !== undefined ? textToHtml(text) : undefined,
            url,
            file_ids: fileIds.length ? fileIds : undefined,
          }),
          comment: comment ? { text_comment: comment } : undefined,
        });
        return compact({
          status: "SUBMITTED",
          assignment: a.name,
          submitted_at: submission.submitted_at,
          attempt: submission.attempt,
          late: submission.late || undefined,
          files: uploads.map((u) => u.name),
          url: a.html_url,
        });
      }),
  );

  server.registerTool(
    "post_discussion_reply",
    {
      title: "Post to a discussion",
      description:
        "Post a reply to a discussion topic, or to a specific entry in it. ALWAYS two steps: call without confirm for a preview, show it to the user, then call again with confirm: true once they approve.",
      inputSchema: {
        course_id: courseId,
        topic_id: z.coerce.string().describe("Discussion topic ID"),
        message: z.string().min(1).describe("Reply text (plain text; paragraphs separated by blank lines)"),
        reply_to_entry_id: z.coerce.string().optional().describe("Reply under this entry instead of the topic itself"),
        confirm,
      },
      annotations: OUTWARD,
    },
    async ({ course_id, topic_id, message, reply_to_entry_id, confirm }) =>
      run(async () => {
        const c = canvas();
        const base = `courses/${course_id}/discussion_topics/${topic_id}`;
        const topic = await c.get<Obj>(base);
        if (topic.locked_for_user || topic.locked) {
          throw new Error(`"${topic.title}" is locked for replies${topic.lock_explanation ? `: ${topic.lock_explanation}` : ""}`);
        }
        if (!confirm) {
          return compact({
            status: "PREVIEW: nothing has been posted yet",
            topic: topic.title,
            replying_to: reply_to_entry_id ? `entry ${reply_to_entry_id}` : "the topic",
            visible_to: "everyone in the course who can see this discussion",
            message,
            next_step: "Show this preview to the user. Only if they approve, call again with confirm: true.",
          });
        }
        const path = reply_to_entry_id ? `${base}/entries/${reply_to_entry_id}/replies` : `${base}/entries`;
        const entry = await c.post<Obj>(path, { message: textToHtml(message) });
        return compact({ status: "POSTED", topic: topic.title, entry_id: entry.id, created_at: entry.created_at, url: topic.html_url });
      }),
  );

  server.registerTool(
    "send_message",
    {
      title: "Send a Canvas Inbox message",
      description:
        "Send a Canvas Inbox message to course staff or classmates (user IDs from list_course_people), or reply in an existing conversation. ALWAYS two steps: call without confirm for a preview, show it to the user, then call again with confirm: true once they approve.",
      inputSchema: {
        body: z.string().min(1).describe("Message text"),
        recipient_ids: z
          .array(z.coerce.string())
          .optional()
          .describe("Canvas user IDs for a new message (omit when replying)"),
        subject: z.string().optional().describe("Subject for a new message"),
        course_id: courseId.optional().describe("Course the new message is about (recommended; Canvas may require it)"),
        conversation_id: z.coerce.string().optional().describe("Reply in this existing conversation instead"),
        confirm,
      },
      annotations: OUTWARD,
    },
    async ({ body, recipient_ids, subject, course_id, conversation_id, confirm }) =>
      run(async () => {
        const c = canvas();
        if (conversation_id) {
          const cv = await c.get<Obj>(`conversations/${conversation_id}`, { auto_mark_as_read: false });
          if (!confirm) {
            return compact({
              status: "PREVIEW: nothing has been sent yet",
              replying_in: cv.subject || "(no subject)",
              participants: cv.participants?.map((p: Obj) => p.name),
              body,
              next_step: "Show this preview to the user. Only if they approve, call again with confirm: true.",
            });
          }
          await c.post(`conversations/${conversation_id}/add_message`, { body });
          return { status: "SENT", conversation_id };
        }

        if (!recipient_ids?.length) throw new Error("Give recipient_ids for a new message, or conversation_id to reply");
        if (!confirm) {
          // Resolve IDs to names through the course roster so the user can check who it's going to.
          const people = course_id
            ? await c
                .getAll<Obj>(`courses/${course_id}/users`, { user_ids: recipient_ids }, recipient_ids.length)
                .catch(() => [] as Obj[])
            : [];
          const names = new Map(people.map((p) => [String(p.id), p.name]));
          return compact({
            status: "PREVIEW: nothing has been sent yet",
            to: recipient_ids.map((id) => names.get(id) ?? `user ${id}`),
            course_id,
            subject,
            body,
            delivery: recipient_ids.length > 1 ? "a separate private message to each recipient" : undefined,
            next_step: "Show this preview to the user. Only if they approve, call again with confirm: true.",
          });
        }
        const sent = await c.post<Obj[]>("conversations", {
          recipients: recipient_ids,
          subject,
          body,
          context_code: course_id ? `course_${course_id}` : undefined,
          group_conversation: false,
        });
        return { status: "SENT", conversation_ids: (Array.isArray(sent) ? sent : [sent]).map((s: Obj) => s.id) };
      }),
  );

  server.registerTool(
    "set_planner_item_done",
    {
      title: "Mark a planner item done",
      description:
        "Mark a planner item as done (or not done) in the user's Canvas to-do list. This only changes the user's own checklist; it does not submit anything. Use plannable type and id from get_planner.",
      inputSchema: {
        plannable_type: z
          .enum(["assignment", "quiz", "discussion_topic", "wiki_page", "planner_note", "calendar_event", "announcement"])
          .describe("The item's type from get_planner"),
        plannable_id: z.coerce.string().describe("The item's id from get_planner"),
        done: z.boolean().optional().describe("true to mark done (default), false to un-mark"),
      },
      annotations: PERSONAL,
    },
    async ({ plannable_type, plannable_id, done = true }) =>
      run(async () => {
        const c = canvas();
        const overrides = await c.getAll<Obj>("planner/overrides");
        const existing = overrides.find(
          (o) => o.plannable_type === plannable_type && String(o.plannable_id) === plannable_id,
        );
        const result = existing
          ? await c.put<Obj>(`planner/overrides/${existing.id}`, { marked_complete: done })
          : await c.post<Obj>("planner/overrides", { plannable_type, plannable_id, marked_complete: done });
        return { status: done ? "MARKED DONE" : "MARKED NOT DONE", plannable_type, plannable_id, override_id: result.id };
      }),
  );

  server.registerTool(
    "create_planner_note",
    {
      title: "Add a personal to-do",
      description:
        "Add a personal to-do note to the user's Canvas planner (visible only to them), optionally tied to a course.",
      inputSchema: {
        title: z.string().min(1).describe("To-do title"),
        todo_date: z.string().describe("Date (user's time zone) or ISO datetime it's for, e.g. 2026-11-03"),
        details: z.string().optional().describe("Extra details"),
        course_id: courseId.optional().describe("Show it under this course"),
      },
      annotations: { ...PERSONAL, idempotentHint: false },
    },
    async ({ title, todo_date, details, course_id }) =>
      run(async () => {
        const c = canvas();
        const { start } = await resolveRange(c, todo_date, undefined, 1);
        const note = await c.post<Obj>("planner_notes", compact({ title, details, todo_date: start.toISOString(), course_id }));
        return compact({ status: "CREATED", id: note.id, title: note.title, todo_date: note.todo_date, course_id: note.course_id });
      }),
  );
}
