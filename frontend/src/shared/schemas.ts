import { z } from "zod";

// Single source of truth for client validation. Mirrors backend Pydantic v2
// schemas in backend/app/schemas/__init__.py (mapping documented in README):
//   TaskCreateIn  <-> taskCreateSchema
//   TaskUpdateIn  <-> taskUpdateSchema (version required)
//   StatusChangeIn/CompleteIn <-> statusChangeSchema/completeSchema
//   LoginIn/RegisterIn <-> loginSchema/registerSchema

export const taskStatusEnum = z.enum(["NEW", "IN_PROGRESS", "DONE", "CANCELLED"]);
export type TaskStatus = z.infer<typeof taskStatusEnum>;

export const loginSchema = z.object({
  email: z.string().email("Введите корректный e-mail"),
  password: z.string().min(8, "Минимум 8 символов").max(256),
});

export const registerSchema = loginSchema.extend({
  full_name: z.string().min(1, "Укажите имя").max(200),
});

export const taskCreateSchema = z.object({
  title: z.string().min(1, "Заголовок обязателен").max(500),
  description: z.string().max(20000).optional().nullable(),
  assignee_id: z.string().uuid().optional().nullable(),
  deadline: z.string().datetime({ offset: true }).optional().nullable(),
  watcher_ids: z.array(z.string().uuid()).default([]),
});

export const taskUpdateSchema = z.object({
  version: z.number().int(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(20000).optional().nullable(),
  assignee_id: z.string().uuid().optional().nullable(),
  deadline: z.string().datetime({ offset: true }).optional().nullable(),
});

export const statusChangeSchema = z.object({
  version: z.number().int(),
  status: taskStatusEnum,
});

export const completeSchema = z.object({
  version: z.number().int(),
  completion_info: z.string().min(1, "Опишите результат").max(5000),
});

export type TaskCreate = z.infer<typeof taskCreateSchema>;
export type TaskUpdate = z.infer<typeof taskUpdateSchema>;

export interface TaskListItem {
  id: string;
  public_no: number;
  title: string;
  status: TaskStatus;
  deadline: string | null;
  is_overdue: boolean;
  version: number;
}

export interface TaskListResponse {
  items: TaskListItem[];
  next_cursor: string | null;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
