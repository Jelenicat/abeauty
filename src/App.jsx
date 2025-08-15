import React from "react";
import { Routes, Route, Navigate, Outlet } from "react-router-dom";
import Home from "./pages/Home";
import AdminHome from "./pages/AdminHome";
import { useAuth } from "./context/AuthContext";
import AdminKatalog from "./pages/AdminKatalog";
import AdminCategory from "./pages/AdminCategory";
import AdminEmployees from "./pages/AdminEmployees";
import AdminCalendar from "./pages/AdminCalendar";
import SelectServices from "./pages/SelectServices";
import BookTime from "./pages/BookTime";
import AdminFinansije from "./pages/AdminFinansije";
import AdminKlijenti from "./pages/AdminKlijenti";

function RezervacijePlaceholder() {
  return (
    <div style={{ padding: 24, color: "#111", background: "#fff", minHeight: "100vh" }}>
      <h2>Rezervacije (placeholder)</h2>
      <p>Ovde ćemo kasnije napraviti pravu stranu.</p>
    </div>
  );
}

// Guard: pusti /admin/* samo adminu
function RequireAdmin() {
  const { user } = useAuth();
  return user?.isAdmin ? <Outlet /> : <Navigate to="/usluge" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/rezervacije" element={<RezervacijePlaceholder />} />

      {/* ADMIN (sve rute ispod su zaštićene) */}
      <Route element={<RequireAdmin />}>
        <Route path="/admin" element={<AdminHome />} />
        <Route path="/admin/katalog" element={<AdminKatalog />} />
        <Route path="/admin/katalog/:categoryId" element={<AdminCategory />} />
        <Route path="/admin/zaposleni" element={<AdminEmployees />} />
        <Route path="/admin/kalendar" element={<AdminCalendar />} />
      </Route>

      {/* KORISNIČKE */}
      <Route path="/usluge" element={<SelectServices />} />
      <Route path="/rezervisi" element={<BookTime />} />
<Route path="/admin/finansije" element={<AdminFinansije />} />
<Route path="/admin/klijenti" element={<AdminKlijenti />} />
      {/* 404 */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    
  );
}
