import { afterEach, describe, expect, it } from "vitest";
import {
  clearMaxLaunchFragment,
  maxStartTaskPath,
  readMaxInitData,
  readMaxStartParam,
} from "./max-bridge";

describe("MAX Bridge helpers", () => {
  afterEach(() => {
    delete window.WebApp;
    window.history.replaceState(null, "", "/");
  });

  it("читает доверенные данные запуска из Bridge", () => {
    window.WebApp = { initData: "auth_date=1&hash=test" };
    expect(readMaxInitData()).toBe("auth_date=1&hash=test");
  });

  it("использует WebAppData из URL до загрузки Bridge", () => {
    window.history.replaceState(null, "", "/max#WebAppData=auth_date%3D1%26hash%3Dtest");
    expect(readMaxInitData()).toBe("auth_date=1&hash=test");
  });

  it("использует WebAppData из query string в web-версии MAX", () => {
    window.history.replaceState(null, "", "/max?WebAppData=auth_date%3D1%26hash%3Dtest");
    expect(readMaxInitData()).toBe("auth_date=1&hash=test");
  });

  it("очищает WebAppData из адреса, сохраняя deep-link параметр", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    window.history.replaceState(
      null,
      "",
      `/max?WebAppData=auth_date%3D1%26hash%3Dtest&WebAppStartParam=task_${id}`,
    );

    clearMaxLaunchFragment();

    expect(window.location.search).not.toContain("WebAppData");
    expect(window.location.search).toContain(`WebAppStartParam=task_${id}`);
    expect(maxStartTaskPath("auth_date=1&hash=test")).toBe(`/max/tasks/${id}`);
  });

  it("принимает допустимый MAX payload task_<UUID>", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(maxStartTaskPath(new URLSearchParams({ start_param: `task_${id}` }).toString()))
      .toBe(`/max/tasks/${id}`);
    expect(maxStartTaskPath("start_param=https%3A%2F%2Fevil.example")).toBeNull();
  });

  it("читает start_param из initDataUnsafe и WebAppStartParam", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    window.WebApp = {
      initData: "auth_date=1&hash=test",
      initDataUnsafe: { start_param: `task_${id}` },
    };
    expect(readMaxStartParam(window.WebApp.initData)).toBe(`task_${id}`);
    expect(maxStartTaskPath(window.WebApp.initData)).toBe(`/max/tasks/${id}`);

    delete window.WebApp;
    window.history.replaceState(null, "", `/max?WebAppStartParam=task_${id}`);
    expect(maxStartTaskPath("auth_date=1&hash=test")).toBe(`/max/tasks/${id}`);
  });
});
