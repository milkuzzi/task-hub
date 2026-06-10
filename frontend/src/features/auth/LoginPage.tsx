import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { loginSchema } from "../../shared/schemas";
import { api } from "../../api/client";
import type { z } from "zod";

type LoginForm = z.infer<typeof loginSchema>;

export default function LoginPage() {
  const { register, handleSubmit, setError, formState: { errors, isSubmitting } } =
    useForm<LoginForm>({ resolver: zodResolver(loginSchema) });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await api("/api/auth/csrf");          // prime CSRF cookie
      await api("/api/auth/login", { method: "POST", body: values });
      window.location.href = "/tasks";
    } catch {
      setError("password", { message: "Неверный e-mail или пароль" });
    }
  });

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-sm space-y-3" noValidate>
      <h1 className="text-xl font-semibold">Вход</h1>
      <div>
        <label htmlFor="email">E-mail</label>
        <input id="email" type="email" autoComplete="email" className="w-full rounded border px-2 py-1"
          aria-invalid={!!errors.email} {...register("email")} />
        {errors.email && <p role="alert" className="text-sm text-red-600">{errors.email.message}</p>}
      </div>
      <div>
        <label htmlFor="password">Пароль</label>
        <input id="password" type="password" autoComplete="current-password" className="w-full rounded border px-2 py-1"
          aria-invalid={!!errors.password} {...register("password")} />
        {errors.password && <p role="alert" className="text-sm text-red-600">{errors.password.message}</p>}
      </div>
      <button disabled={isSubmitting} className="rounded bg-blue-600 px-4 py-2 text-white">Войти</button>
    </form>
  );
}
