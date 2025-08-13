import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import { FiLogOut } from "react-icons/fi";
import "./AdminHome.css";

export default function AdminHome() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  // zaštita da klijent ne uđe na /admin
  useEffect(() => {
    if (!user?.isAdmin) navigate("/usluge", { replace: true });
  }, [user, navigate]);

  const handleLogout = async () => {
    try {
      // očekuje se da AuthContext ima logout() koji čisti sesiju/localStorage
      await (logout?.() ?? Promise.resolve());
    } finally {
      navigate("/login", { replace: true }); // ili "/" po tvojoj ruti
    }
  };

  return (
    <div className="admin-wrap">
      {/* Dugme za odjavu gore desno */}
      <button className="admin-logout" onClick={handleLogout} title="Odjavi se">
        <FiLogOut style={{ marginRight: 8 }} />
        Odjavi se
      </button>

      <div className="admin-panel">
        <h2 className="admin-title">Admin panel</h2>

        <div className="admin-grid">
          <button className="admin-card" onClick={() => navigate("/admin/katalog")}>
            Katalog usluga
          </button>
          <button className="admin-card" onClick={() => navigate("/admin/kalendar")}>
            Kalendar
          </button>
          <button className="admin-card" onClick={() => navigate("/admin/finansije")}>
            Troškovi i zarada
          </button>
          <button className="admin-card" onClick={() => navigate("/admin/zaposleni")}>
            Zaposleni
          </button>
        </div>
      </div>
    </div>
  );
}
