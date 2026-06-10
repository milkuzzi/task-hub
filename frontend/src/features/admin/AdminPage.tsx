import { useState } from "react";
import { useUsers, useCreateUser, useUpdateUser, useDeactivateUser } from "./users";

export default function AdminPage() {
  const q = useUsers();
  const create = useCreateUser();
  const update = useUpdateUser();
  const deactivate = useDeactivateUser();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [admin, setAdmin] = useState(false);

  return (
    <section className="space-y-4">
      <h1 className="text-xl font-semibold">Реестр пользователей</h1>

      <form className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => { e.preventDefault(); if (email && name) { create.mutate({ email, full_name: name, is_admin: admin }); setEmail(""); setName(""); setAdmin(false); } }}>
        <label className="flex flex-col text-sm">E-mail
          <input className="rounded border px-2 py-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="flex flex-col text-sm">Имя
          <input className="rounded border px-2 py-1" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Админ
        </label>
        <button className="rounded bg-blue-600 px-3 py-1 text-white" type="submit">Добавить в реестр</button>
      </form>
      {create.isError && <p role="alert" className="text-sm text-red-600">Не удалось создать пользователя</p>}

      <table className="w-full text-left">
        <thead><tr><th>E-mail</th><th>Имя</th><th>Админ</th><th>Активен</th><th>Действия</th></tr></thead>
        <tbody>
          {(q.data ?? []).map((u) => (
            <tr key={u.id} className="border-t">
              <td>{u.email}</td><td>{u.full_name}</td>
              <td><button className="underline" onClick={() => update.mutate({ id: u.id, patch: { is_admin: !u.is_admin } })}>{u.is_admin ? "да" : "—"}</button></td>
              <td>{u.is_active ? "да" : "—"}</td>
              <td>{u.is_active && <button className="text-sm text-red-600" onClick={() => deactivate.mutate(u.id)}>Деактивировать</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
