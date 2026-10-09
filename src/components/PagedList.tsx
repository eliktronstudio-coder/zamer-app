import { useState, Fragment, type ReactNode } from "react";
export function PagedList<T extends { id: string }>({
  items,
  label,
  render,
  className,
  as: Container = "div",
}: {
  items: T[];
  label: string;
  render: (item: T) => ReactNode;
  className?: string;
  as?: "div" | "ul";
}) {
  const [requestedPage, setPage] = useState(0);
  const pageSize = 24,
    pages = Math.max(1, Math.ceil(items.length / pageSize)),
    page = Math.min(requestedPage, pages - 1),
    start = page * pageSize;
  return (
    <>
      {items.length > pageSize && (
        <nav className="list-pagination" aria-label={`${label}: страницы`}>
          <button
            aria-label={`${label}: предыдущая страница`}
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            ← Назад
          </button>
          <span role="status">
            {label}: {start + 1}–{Math.min(start + pageSize, items.length)} из{" "}
            {items.length} · страница {page + 1} из {pages}
          </span>
          <button
            aria-label={`${label}: следующая страница`}
            disabled={page === pages - 1}
            onClick={() => setPage(page + 1)}
          >
            Далее →
          </button>
        </nav>
      )}
      <Container className={className}>
        {items.slice(start, start + pageSize).map((item) => (
          <Fragment key={item.id}>{render(item)}</Fragment>
        ))}
      </Container>
    </>
  );
}
