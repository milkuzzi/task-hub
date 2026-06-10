"""Idempotent notification insert: the unique (task,user,type,target_date) means
a second INSERT ON CONFLICT DO NOTHING yields rowcount 0 -> no double-send.
This is a logic-level simulation of the DB guarantee.
"""

class FakeResult:
    def __init__(self, rc): self.rowcount = rc

class FakeConn:
    def __init__(self): self.seen = set()
    def execute(self, _sql, params):
        key = (params["t"], params["u"], params["ty"], params["d"])
        if key in self.seen:
            return FakeResult(0)
        self.seen.add(key)
        return FakeResult(1)


def _try(conn, **p):
    r = conn.execute("INSERT...", {"t": p["t"], "u": p["u"], "ty": p["ty"], "d": p["d"]})
    return r.rowcount == 1


def test_send_only_once():
    c = FakeConn()
    args = dict(t="task1", u="user1", ty="DUE_DAY", d="2026-06-10")
    assert _try(c, **args) is True     # first -> send
    assert _try(c, **args) is False    # duplicate -> suppressed
    assert _try(c, **{**args, "d": "2026-06-11"}) is True  # new day -> send
