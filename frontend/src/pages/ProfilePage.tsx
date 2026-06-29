import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/lib/use-auth";
import { ApiError } from "@/lib/api";
import { updateProfileName } from "@/lib/auth-api";
import { AvatarUploader } from "@/components/AvatarUploader";
import { ChangePasswordForm } from "@/components/ChangePasswordForm";
import { MaxLinkSection } from "@/components/MaxLinkSection";

/**
 * Экран профиля Пользователя (Req 6.1, 6.4, 6.6).
 *
 * Объединяет:
 * - просмотр основных данных (email/имя);
 * - смену собственного аватара (Req 6.4);
 * - смену собственного пароля (Req 6.1, 6.7);
 * - привязку собственного профиля MAX (Req 6.6).
 */
export function ProfilePage(): JSX.Element {
  const { t } = useTranslation();
  const { user, setUser } = useAuth();
  const [nameDraft, setNameDraft] = useState("");
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  useEffect(() => {
    setNameDraft(user?.name ?? "");
    setNameError(null);
    setNameSaved(false);
  }, [user?.name]);

  if (user === null) {
    return (
      <section>
        <p>{t("common.loading")}</p>
      </section>
    );
  }

  async function handleNameSubmit(
    event: FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (user === null || nameBusy) {
      return;
    }

    const trimmed = nameDraft.trim();
    setNameError(null);
    setNameSaved(false);
    if (trimmed.length === 0 || trimmed.length > 200) {
      setNameError(t("profile.name.error"));
      return;
    }
    if (trimmed === user.name) {
      setNameSaved(true);
      return;
    }

    setNameBusy(true);
    try {
      const updated = await updateProfileName(trimmed);
      setUser(updated);
      setNameSaved(true);
    } catch (err) {
      setNameError(err instanceof ApiError ? err.message : t("errors.generic"));
    } finally {
      setNameBusy(false);
    }
  }

  return (
    <section className="stack page-section">
      <div className="page-head">
        <div className="page-head__content">
          <h1>{t("profile.heading")}</h1>
        </div>
      </div>

      <article className="panel panel--compact account-workbench">
        <section className="account-summary">
          <div>
            <h2 className="account-summary__name">{user.name}</h2>
            <p className="account-summary__line">{user.email}</p>
          </div>
          {user.role === "ADMIN" && (
            <form
              className="stack"
              onSubmit={(e) => void handleNameSubmit(e)}
              noValidate
            >
              <label className="field">
                <span className="field__label">{t("profile.name.label")}</span>
                <input
                  className="field__input"
                  type="text"
                  value={nameDraft}
                  maxLength={200}
                  onChange={(e) => {
                    setNameDraft(e.target.value);
                    setNameSaved(false);
                  }}
                  disabled={nameBusy}
                />
              </label>
              {nameError !== null && (
                <p className="form-error" role="alert">
                  {nameError}
                </p>
              )}
              {nameSaved && (
                <p className="form-success" role="status">
                  {t("profile.name.updated")}
                </p>
              )}
              <button
                className="btn btn--primary"
                type="submit"
                disabled={nameBusy}
              >
                {nameBusy ? t("common.saving") : t("profile.name.save")}
              </button>
            </form>
          )}
          <AvatarUploader />
        </section>

        <section className="account-workbench__section">
          <h2>{t("profile.password.heading")}</h2>
          <ChangePasswordForm />
        </section>

        <section className="account-workbench__section">
          <h2>{t("profile.max.heading")}</h2>
          <MaxLinkSection />
        </section>
      </article>
    </section>
  );
}
