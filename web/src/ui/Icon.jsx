// Набор линейных иконок 20×20 для меню.
const P = {
  overview: "M3 11l7-7 7 7M5 9.5V17h4v-4h2v4h4V9.5",
  screener: "M3 4h14M5.5 9h9M8 14h4",
  bots: "M6 7h8a2 2 0 012 2v5a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2zM10 3v4M7.5 11.5h.01M12.5 11.5h.01",
  trades: "M4 6h12M4 6l3-3M4 6l3 3M16 14H4M16 14l-3-3M16 14l-3 3",
  stats: "M4 16V9M8.5 16V5M13 16v-5M17 16H3",
  exchanges: "M3 8.5L10 4l7 4.5M5 9v6M10 9v6M15 9v6M3 16.5h14",
  profile: "M10 10a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM4 17c.8-3 3.2-4.5 6-4.5s5.2 1.5 6 4.5",
  security: "M10 3l6 2.3v4.2c0 3.6-2.5 6.3-6 7.5-3.5-1.2-6-3.9-6-7.5V5.3L10 3zM7.5 10l1.8 1.8 3.3-3.6",
  guide: "M4 4.5A1.5 1.5 0 015.5 3H15v12H5.5A1.5 1.5 0 004 16.5v-12zM4 16.5A1.5 1.5 0 005.5 18H15M7.5 7h4.5",
  wallet: "M4 6.5A1.5 1.5 0 015.5 5H15v2.5M4 6.5V15a1.5 1.5 0 001.5 1.5H16V8H5.5A1.5 1.5 0 014 6.5zM13 12.2h.01",
  referrals: "M7 9a2.5 2.5 0 100-5 2.5 2.5 0 000 5zM2.5 16c.6-2.4 2.3-3.7 4.5-3.7s3.9 1.3 4.5 3.7M13.5 8.5a2 2 0 100-4M14.5 12.4c1.5.4 2.5 1.6 3 3.6",
  logout: "M8 4H5v12h3M12 13.5L15.5 10 12 6.5M15.5 10H8",
  menu: "M3.5 6h13M3.5 10h13M3.5 14h13",
  plus: "M10 4.5v11M4.5 10h11",
};

export default function Icon({ name, size = 18 }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name]} />
    </svg>
  );
}
