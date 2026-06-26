-- Рефакторинг Вложений: nullable-связь с Сообщением вместо черновиков-носителей.
-- `Attachment.messageId` становится необязательным; добавляются прямые поля
-- `taskId` (для проверки членства в Чате Задачи), `uploaderId` (право на
-- привязку) и `createdAt` (момент загрузки). Существующие строки заполняются по
-- связи Сообщение → Чат → Задача и автору Сообщения.

-- DropForeignKey
ALTER TABLE "Attachment" DROP CONSTRAINT "Attachment_messageId_fkey";

-- AlterTable: messageId -> nullable; добавление новых столбцов.
ALTER TABLE "Attachment"
    ALTER COLUMN "messageId" DROP NOT NULL,
    ADD COLUMN "taskId" UUID,
    ADD COLUMN "uploaderId" UUID,
    ADD COLUMN "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: taskId из Сообщение -> Чат -> Задача.
UPDATE "Attachment" a
SET "taskId" = c."taskId"
FROM "Message" m
JOIN "Chat" c ON c."id" = m."chatId"
WHERE m."id" = a."messageId";

-- Backfill: uploaderId из автора Сообщения.
UPDATE "Attachment" a
SET "uploaderId" = m."authorId"
FROM "Message" m
WHERE m."id" = a."messageId";

-- taskId обязателен после заполнения существующих строк.
ALTER TABLE "Attachment" ALTER COLUMN "taskId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Attachment_taskId_idx" ON "Attachment"("taskId");

-- CreateIndex
CREATE INDEX "Attachment_uploaderId_idx" ON "Attachment"("uploaderId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
