"""WeasyPrint PDF export from a Jinja template with an embedded Cyrillic font.
Served as attachment + nosniff; access gated by the view permission upstream.
"""
from __future__ import annotations

from jinja2 import Environment, FileSystemLoader, select_autoescape

_env = Environment(
    loader=FileSystemLoader("app/templates"),
    autoescape=select_autoescape(["html"]),
)


def render_task_pdf(task: dict) -> bytes:
    from weasyprint import HTML  # imported lazily (native deps)
    html = _env.get_template("task_pdf.html").render(task=task)
    return HTML(string=html).write_pdf()
