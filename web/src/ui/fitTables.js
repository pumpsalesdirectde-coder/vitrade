// Таблицы без горизонтальной прокрутки: если таблица не помещается в ширину блока,
// она перестраивается в карточки (класс .stack), а заголовки колонок становятся подписями ячеек.

function label(table) {
  const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim());
  if (!heads.length) return;
  for (const tr of table.querySelectorAll("tbody tr")) {
    let i = 0;
    for (const td of tr.children) {
      const text = heads[i] || "";
      if (td.dataset.label !== text) td.dataset.label = text;
      i += td.colSpan || 1;
    }
  }
}

function fit(wrap) {
  const table = wrap.querySelector(":scope > table.grid-table");
  if (!table || table.classList.contains("no-stack")) return;
  label(table);
  const cs = getComputedStyle(wrap);
  const room = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (table.classList.contains("stack")) {
    // обратно в таблицу, только если её естественная ширина снова помещается
    if (room >= Number(table.dataset.natural || Infinity)) {
      table.classList.remove("stack");
      if (table.scrollWidth > room + 1) table.classList.add("stack");
    }
  } else if (table.scrollWidth > room + 1) {
    table.dataset.natural = table.scrollWidth;
    table.classList.add("stack");
  }
}

export function fitTables(root = document.body) {
  let queued = false;
  const run = () => {
    queued = false;
    for (const wrap of root.querySelectorAll(".table-wrap")) fit(wrap);
  };
  const schedule = () => {
    if (!queued) {
      queued = true;
      setTimeout(run, 30);
    }
  };
  new MutationObserver(schedule).observe(root, { childList: true, subtree: true, characterData: true });
  addEventListener("resize", schedule);
  schedule();
}
