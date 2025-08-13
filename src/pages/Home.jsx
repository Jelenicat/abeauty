import React, { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./Home.css";
import LoginModal from "../components/LoginModal";

export default function Home() {
  const [scrolled, setScrolled] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  const navigate = useNavigate();
  const { user, isLoggedIn, logout } = useAuth();

  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const goUsluge = () => {
    if (isLoggedIn) navigate("/usluge");
    else setLoginOpen(true);
  };

  const handleZakazi = () => {
    if (!isLoggedIn) return setLoginOpen(true);
    navigate(user?.isAdmin ? "/admin" : "/usluge");
  };

  return (
    <div className="home-screen">
      {/* NAVBAR */}
      <nav className={`top-bar ${scrolled ? "scrolled" : ""}`}>
        <img src="/logo.png" alt="aBeauty logo" className="logo" />

        {/* desni deo trake */}
        <div className="top-right">
          {!isLoggedIn ? (
            <button className="btn-ghost" onClick={() => setLoginOpen(true)}>
              Uloguj se
            </button>
          ) : (
            <>
              <span className="hello-text">Ćao, {user.firstName}</span>
              <button className="btn-ghost" onClick={goUsluge}>
                Zakaži
              </button>
              <button className="btn-primary" onClick={logout}>
                Odjavi se
              </button>
            </>
          )}
        </div>
      </nav>

      {/* HERO */}
      <section className="hero-section">
        <button className="zakazi-btn" onClick={handleZakazi}>
          Zakaži termin
        </button>
      </section>

      {/* O NAMA */}
      <section className="o-nama-section" id="o-nama">
        <h2 className="o-nama-title">O nama</h2>
        <p className="o-nama-text">
          Frizersko kozmetički salon <strong>aBeauty</strong> nastao je iz ljubavi i želje da se lepota i negovan izgled istaknu na svakom pojedincu. 
          Prepustite nam se i zakažite svoj trenutak u kome Vas čeka kraljevski tretman, a u kome ćete se osetiti kao u udobnosti svog doma.
        </p>
        <div className="o-nama-buttons">
          <button className="custom-btn" onClick={() => window.scrollTo({ top: document.body.scrollHeight / 2, behavior: "smooth" })}>
            Galerija
          </button>
          <button className="custom-btn" onClick={goUsluge}>
            Usluge
          </button>
        </div>
      </section>

      {/* LOKACIJA */}
      <section className="lokacija-section" id="lokacija">
        <h2 className="lokacija-title">Gde se nalazimo?</h2>
        <div className="lokacija-mapa">
          <iframe
            title="Mapa salona"
            src="https://www.google.com/maps/dir//Ju%C5%BEni+bulevar+19,+Beograd+11000/@44.7926275,20.3896785,12z/data=!3m1!4b1!4m8!4m7!1m0!1m5!1m1!1s0x475a716f054f6fd7:0xd396688a3e8a9117!2m2!1d20.4721163!2d44.7925747?entry=ttu"
            width="100%"
            height="450"
            style={{ border: 0 }}
            allowFullScreen
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
          />
        </div>
      </section>

      {/* malo spacera ispod */}
      <div style={{ height: "120vh" }} />

      {/* LOGIN MODAL */}
      <LoginModal
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onSuccess={(u) => {
          setLoginOpen(false);
          navigate(u?.isAdmin ? "/admin" : "/usluge");
        }}
      />
    </div>
  );
}
