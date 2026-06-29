import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, setSessionBearerToken } from "@/lib/api";
import {
  linkAndLoginWithMaxMiniApp,
  loginWithMaxMiniApp,
} from "@/lib/auth-api";
import { AuthContext, type AuthContextValue } from "@/lib/use-auth";
import { setSocketAuthToken } from "@/lib/socket";
import { MaxAppRoot } from "./MaxAppRoot";

vi.mock("@/lib/auth-api", () => ({
  loginWithMaxMiniApp: vi.fn(),
  linkAndLoginWithMaxMiniApp: vi.fn(),
}));

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

describe("MaxAppRoot", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.WebApp = { initData: "auth_date=1&hash=test" };
    setSessionBearerToken(null);
    setSocketAuthToken(null);
    vi.mocked(loginWithMaxMiniApp).mockReset();
    vi.mocked(linkAndLoginWithMaxMiniApp).mockReset();
  });

  it("does not show explanatory Task Hub copy in the MAX link form", async () => {
    vi.mocked(loginWithMaxMiniApp).mockRejectedValue(
      new ApiError("Профиль MAX ещё не привязан.", "STATE_CONFLICT", 409, {
        reason: "MAX_NOT_LINKED",
      }),
    );

    render(
      <AuthContext.Provider value={authValue()}>
        <MemoryRouter initialEntries={["/max"]}>
          <Routes>
            <Route path="/max" element={<MaxAppRoot />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(await screen.findByLabelText("Email")).toBeVisible();
    expect(
      screen.queryByText("Войдите в Task Hub, чтобы привязать этот профиль MAX."),
    ).not.toBeInTheDocument();
  });
});
