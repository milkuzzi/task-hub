import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";

interface UserRow { id: string; email: string; full_name: string; is_admin: boolean; is_active: boolean; }

export default function AdminPage() {
  const q = useQuery({
    queryKey: ["admin", "users"],
    queryFn: async () => (await api<UserRow[]>("/api/users")).data,
  });
  return (
    <section>
      <h1 className="mb-3 text-xl font-semibold">Реестр пользователей</h1>
      <table className="w-full text-left">
        <thead><tr><th>E-mail</th><th>Имя</th><th>Админ</th><th>Активен</th></tr></thead>
        <tbody>
          {(q.data ?? []).map((u) => (
            <tr key={u.id} className="border-t">
              <td>{u.email}</td><td>{u.full_name}</td>
              <td>{u.is_admin ? "да" : "—"}</td><td>{u.is_active ? "да" : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
