import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "@/lib/use-auth";
import { LoginPage } from "./LoginPage";

function authValue(): AuthContextValue {
  return {
    user: null,
    initializing: false,
    isAuthenticated: false,
    signIn: vi.fn(),
    signInWithMax: vi.fn(),
    signOut: vi.fn(),
    setUser: vi.fn(),
  };
}

function renderLogin(): HTMLElement {
  const { container } = render(
    <AuthContext.Provider value={authValue()}>
      <MemoryRouter initialEntries={["/login"]}>
        <LoginPage />
      </MemoryRouter>
    </AuthContext.Provider>,
  );
  return container;
}

describe("LoginPage", () => {
  it("shows the provided logo and no home link", () => {
    const container = renderLogin();

    expect(
      container.querySelector('img.auth-logo[src="/logo2090.png"]'),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "На главную" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Забыли пароль?" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });
});
