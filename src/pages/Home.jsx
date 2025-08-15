import React, { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./Home.css";
import LoginModal from "../components/LoginModal";

/* Firestore za čitanje usluga */
import { db } from "../firebase";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
} from "firebase/firestore";

export default function Home() {
  const [scrolled, setScrolled] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  // Splash (samo mobilni)
  const [showSplash, setShowSplash] = useState(() => {
    if (typeof window !== "undefined") {
      return window.matchMedia("(max-width: 768px)").matches;
    }
    return false;
  });
  const splashClosedRef = useRef(false);

  // Galerija
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryImages] = useState(
    Array.from({ length: 21 }, (_, i) => `/galerija${i + 1}.jpg`)
  );
  const [currentImage, setCurrentImage] = useState(0);

  // Usluge (read-only + kategorije)
  const [servicesOpen, setServicesOpen] = useState(false);
  const [categories, setCategories] = useState([]); // {id, name, order}
  const [services, setServices] = useState([]);     // {id, name, price, duration, categoryId/category}
  const [loadingServices, setLoadingServices] = useState(false);
  const [selectedCatId, setSelectedCatId] = useState(null);

  const navigate = useNavigate();
  const { user, isLoggedIn, logout } = useAuth();

  /* ===== UI helpers ===== */
  const money = (v) =>
    v == null || v === ""
      ? ""
      : new Intl.NumberFormat("sr-RS", {
          style: "currency",
          currency: "RSD",
          maximumFractionDigits: 0,
        }).format(Number(String(v).replace(/[^\d]/g, "")));

  const dur = (min) => {
    const n = Number(min || 0);
    return n ? `${n} min` : "";
  };

  /* ===== Scroll top bar ===== */
  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  /* ===== Splash ===== */
  const closeSplash = () => {
    if (splashClosedRef.current) return;
    splashClosedRef.current = true;
    setShowSplash(false);
    document.body.classList.remove("no-scroll");
  };

  useEffect(() => {
    if (!showSplash) return;
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      closeSplash();
      return;
    }
    document.body.classList.add("no-scroll");
    const img = new Image();
    img.src = "/slikadobrodosli.webp";
    const maxTimeout = setTimeout(closeSplash, 4500);
    img.onload = () => {
      setTimeout(closeSplash, 2000);
    };
    return () => {
      clearTimeout(maxTimeout);
      document.body.classList.remove("no-scroll");
    };
  }, [showSplash]);

  /* ===== Galerija ===== */
  const openGallery = () => {
    setGalleryOpen(true);
    setCurrentImage(0);
    document.body.classList.add("gallery-open");
  };
  const closeGallery = () => {
    setGalleryOpen(false);
    document.body.classList.remove("gallery-open");
  };

  /* ===== Usluge (modal) ===== */
  const openServices = () => {
    setServicesOpen(true);
    document.body.classList.add("gallery-open"); // zaključa scroll
  };
  const closeServices = () => {
    setServicesOpen(false);
    document.body.classList.remove("gallery-open");
  };

  // Učitavanje kategorija/usluga kad se otvori modal
  useEffect(() => {
    if (!servicesOpen) return;
    setLoadingServices(true);

    const unsubscribers = [];

    // Kategorije (ako postoje)
    try {
      const qCats = query(collection(db, "categories"), orderBy("order", "asc"));
      const unCat = onSnapshot(qCats, (snap) => {
        const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setCategories(arr);
      });
      unsubscribers.push(unCat);
    } catch {
      setCategories([]);
    }

    // Usluge
    try {
      const qSv = query(collection(db, "services"), orderBy("order", "asc"));
      const unSv = onSnapshot(qSv, (snap) => {
        const arr = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setServices(arr);
        setLoadingServices(false);
      });
      unsubscribers.push(unSv);
    } catch {
      setServices([]);
      setLoadingServices(false);
    }

    return () => unsubscribers.forEach((u) => u && u());
  }, [servicesOpen]);

  // Izvedene kategorije ako kolekcija categories ne postoji
  const derivedCategories = useMemo(() => {
    if (categories.length > 0) return categories;

    // Bez categories – izvuci jedinstvene nazive iz services.category
    const names = new Map();
    for (const s of services) {
      const key = (s.categoryId || s.category || "Usluge").toString();
      if (!names.has(key)) {
        names.set(key, { id: key, name: key, order: 9999 });
      }
    }
    return Array.from(names.values()).sort(
      (a, b) =>
        (a.order ?? 9999) - (b.order ?? 9999) ||
        String(a.name || "").localeCompare(String(b.name || ""))
    );
  }, [categories, services]);

  // Trenutno selektovana kategorija: default — prva
  useEffect(() => {
    if (!servicesOpen) return;
    if (!derivedCategories.length) {
      setSelectedCatId(null);
      return;
    }
    // Ako trenutno selektovana više ne postoji, uzmi prvu
    const exists = derivedCategories.some((c) => c.id === selectedCatId);
    if (!exists) setSelectedCatId(derivedCategories[0].id);
  }, [servicesOpen, derivedCategories, selectedCatId]);

  // Usluge za izabranu kategoriju
  const servicesForSelected = useMemo(() => {
    if (!selectedCatId) return [];
    const arr = services.filter((s) => {
      const cid = (s.categoryId || s.category || "Usluge").toString();
      return cid === selectedCatId;
    });
    return arr.sort(
      (a, b) =>
        (a.order ?? 9999) - (b.order ?? 9999) ||
        String(a.name || "").localeCompare(String(b.name || ""))
    );
  }, [services, selectedCatId]);

  /* ===== Dugmad ===== */
  const goUsluge = () => {
    // otvori read-only modal
    openServices();
  };

  const handleZakazi = () => {
    if (!isLoggedIn) return setLoginOpen(true);
    navigate(user?.isAdmin ? "/admin" : "/usluge");
  };

  return (
    <div className="home-screen">
      {/* SPLASH */}
      {showSplash && (
        <div className="splash" role="status" aria-label="Učitavanje">
          <div className="splash-bg" />
          <img className="splash-logo" src="/logo.png" alt="aBeauty" />
        </div>
      )}

      {/* NAVBAR */}
      <nav className={`top-bar ${scrolled ? "scrolled" : ""}`}>
        <img src="/logo.png" alt="aBeauty logo" className="logo" />
        <div className="top-right">
          {!isLoggedIn ? (
            <button className="btn-ghost" onClick={() => setLoginOpen(true)}>
              Uloguj se
            </button>
          ) : (
            <>
              <span className="hello-text">Ćao, {user.firstName}</span>
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
          Frizersko kozmetički salon <strong>aBeauty</strong> nastao je iz
          ljubavi i želje da se lepota i negovan izgled istaknu na svakom
          pojedincu.
        </p>
        <div className="o-nama-buttons">
          <button className="custom-btn" onClick={openGallery}>
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
      src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d2830.9182505!2d20.4721163!3d44.7925747!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x475a716f054f6fd7%3A0xd396688a3e8a9117!2sJu%C5%BEni%20bulevar%2019%2C%20Beograd!5e0!3m2!1ssr!2srs!4v1691234567890!5m2!1ssr!2srs"
      width="80%"
      height="250"
      style={{ border: 0 }}
      allowFullScreen
      loading="lazy"
      referrerPolicy="no-referrer-when-downgrade"
    />
  </div>

  <div className="lokacija-info">
    <span className="lokacija-icon">📍</span>
    <span className="lokacija-adresa">Južni bulevar 19, Beograd 11000</span>
  </div>
</section>


      {/* GALLERY MODAL */}
      {galleryOpen && (
        <div className="gallery-overlay" onClick={closeGallery}>
          <div className="gallery-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="gallery-topbar">
              <div className="gallery-counter">
                {currentImage + 1} / {galleryImages.length}
              </div>
              <button className="gallery-close" onClick={closeGallery} aria-label="Zatvori">
                ✕
              </button>
            </div>

            <div className="gallery-stage">
              <img
                className="gallery-image"
                src={galleryImages[currentImage]}
                alt={`Slika ${currentImage + 1}`}
              />
              <button
                className="gallery-nav gallery-prev"
                onClick={() =>
                  setCurrentImage((p) => (p === 0 ? galleryImages.length - 1 : p - 1))
                }
                aria-label="Prethodna slika"
              >
                ❮
              </button>
              <button
                className="gallery-nav gallery-next"
                onClick={() =>
                  setCurrentImage((p) => (p === galleryImages.length - 1 ? 0 : p + 1))
                }
                aria-label="Sledeća slika"
              >
                ❯
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SERVICES (READ-ONLY, KATEGORIJE -> USLUGE) */}
      {servicesOpen && (
        <div className="gallery-overlay" onClick={closeServices}>
          <div className="services2-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="services2-topbar">
              <h3>Usluge</h3>
              <button className="gallery-close" onClick={closeServices} aria-label="Zatvori">
                ✕
              </button>
            </div>

            <div className="services2-body">
              {/* Sidebar kategorije */}
              <aside className="services2-cats">
                {loadingServices && !derivedCategories.length ? (
                  <div className="services2-loading">Učitavanje…</div>
                ) : (
                  derivedCategories.map((c) => (
                    <button
                      key={c.id}
                      className={
                        "services2-catbtn" + (c.id === selectedCatId ? " active" : "")
                      }
                      onClick={() => setSelectedCatId(c.id)}
                    >
                      {c.name || "Kategorija"}
                    </button>
                  ))
                )}
              </aside>

              {/* Lista usluga za izabranu kategoriju */}
              <main className="services2-list">
                {loadingServices && !services.length ? (
                  <div className="services2-loading">Učitavanje…</div>
                ) : servicesForSelected.length === 0 ? (
                  <div className="services2-empty">Nema usluga za odabranu kategoriju.</div>
                ) : (
                  <div className="services2-grid">
                    {servicesForSelected.map((s) => (
                      <div key={s.id} className="svc2-item">
                        <div className="svc2-header">
                          <div className="svc2-name">{s.name || s.naziv || "Usluga"}</div>
                          <div className="svc2-price">
                            {money(s.price ?? s.cena)}
                            {s.duration ? <span className="svc2-dot">•</span> : null}
                            {s.duration ? <span className="svc2-dur">{dur(s.duration)}</span> : null}
                          </div>
                        </div>
                        {s.description || s.opis ? (
                          <div className="svc2-desc">{s.description || s.opis}</div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </main>
            </div>

            <div className="services2-footer">
              <div className="services-note">
                Ovo je pregled po kategorijama. Zakazivanje nije omogućeno u ovom prikazu.
              </div>
            </div>
          </div>
        </div>
      )}

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
