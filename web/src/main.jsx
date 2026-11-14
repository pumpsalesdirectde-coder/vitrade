import { createRoot } from "react-dom/client";
import "@fontsource-variable/onest";
import "./styles.css";
import App from "./App.jsx";
import { fitTables } from "./ui/fitTables.js";

fitTables();

createRoot(document.getElementById("root")).render(<App />);
