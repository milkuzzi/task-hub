import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestPasswordReset } from "@/lib/auth-api";
import { ApiError } from "@/lib/api";
import { ForgotPasswordPage } from "./ForgotPasswordPage";

vi.mock("@/lib/auth-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth-api")>(
    "@/lib/auth-api",
  );
  return { ...actual, requestPasswordReset: vi.fn() };
});

const mockedRequestPasswordReset = vi.mocked(requestPasswordReset);

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/forgot-password"]}>
      <ForgotPasswordPage />
    </MemoryRouter>,
  );
}

describe("ForgotPasswordPage", () => {
  beforeEach(() => {
    mockedRequestPasswordReset.mockReset();
  });

  it("requests a reset link and shows a neutral success message", async () => {
    mockedRequestPasswordReset.mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderPage();
    await user.type(
      screen.getByLabelText("Электронная почта"),
      "user@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Отправить ссылку" }));

    expect(mockedRequestPasswordReset).toHaveBeenCalledWith("user@example.com");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Если учётная запись с таким адресом существует",
    );
    expect(
      screen.getByRole("link", { name: "Вернуться ко входу" }),
    ).toHaveAttribute("href", "/login");
  });

  it("shows backend validation errors", async () => {
    mockedRequestPasswordReset.mockRejectedValue(
      new ApiError(
        "Адрес электронной почты имеет недопустимый формат.",
        "VALIDATION_ERROR",
        400,
        undefined,
      ),
    );
    const user = userEvent.setup();

    renderPage();
    await user.type(screen.getByLabelText("Электронная почта"), "wrong");
    await user.click(screen.getByRole("button", { name: "Отправить ссылку" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Адрес электронной почты имеет недопустимый формат.",
    );
  });
});
