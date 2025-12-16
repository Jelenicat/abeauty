import React, { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";
import "./Home.css";
import LoginModal from "../components/LoginModal";

/* Firestore */
import { db } from "../firebase";
import {
  collection,
  onSnapshot,
  orderBy,
  query,
  where,
  updateDoc,
  doc,
} from "firebase/firestore";
import { setDoc, serverTimestamp, runTransaction, getDocs, deleteField } from "firebase/firestore";

/* ======================= LazyThumb (thumbnail sa lazy-load) ======================= */
function LazyThumb({ src, alt, onClick, isActive }) {
  const ref = useRef(null);
  const [inView, setInView] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const srcThumb = toThumb(src);

  return (
    <button
      ref={ref}
      onClick={onClick}
      style={{
        border: isActive ? "2px solid #ff7fb5" : "1px solid rgba(255,255,255,.35)",
        padding: 0,
        borderRadius: 10,
        overflow: "hidden",
        background: "rgba(255,255,255,.1)",
        cursor: "pointer",
        width: 76,
        height: 76,
        flex: "0 0 auto",
      }}
      aria-label={alt}
      title={alt}
    >
      {inView ? (
        <img
          src={srcThumb}
          alt={alt}
          loading="lazy"
          onLoad={() => setLoaded(true)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            filter: loaded ? "none" : "blur(6px)",
            transition: "filter .3s ease",
            display: "block",
          }}
          onError={(e) => {
            // ako thumb ne postoji – fallback na original
            e.currentTarget.src = src;
          }}
        />
      ) : (
        <div style={{ width: "100%", height: "100%" }} />
      )}
    </button>
  );
}

/* ======================= Komponenta Home ======================= */

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

  // Progressive loading state za glavnu (hi-res) sliku
  const [heroLoaded, setHeroLoaded] = useState(false);
  const [heroHiResReady, setHeroHiResReady] = useState(false);

  // Usluge (read-only + kategorije)
  const [servicesOpen, setServicesOpen] = useState(false);
  const [categories, setCategories] = useState([]); // {id, name, order}
  const [services, setServices] = useState([]);     // {id, name, price, duration, categoryId/category}
  const [loadingServices, setLoadingServices] = useState(false);
  const [selectedCatId, setSelectedCatId] = useState(null);

  // Moji zakazani termini (+ modal za otkazivanje)
  const [myAppointments, setMyAppointments] = useState([]);
  const [cancelModalOpen, setCancelModalOpen] = useState(false);
// Prošli termini
const [pastAppointments, setPastAppointments] = useState([]);
const [pastModalOpen, setPastModalOpen] = useState(false);

  const navigate = useNavigate();
  const { user, isLoggedIn, logout } = useAuth();

  /* ===== Helpers ===== */
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

  const dateKeyTimeToLocalDate = (dateKey, hhmm) => {
    // Local time; primer: "2025-01-20T14:30"
    return new Date(`${dateKey}T${hhmm}`);
  };
  const diffHours = (futureDate, base = new Date()) =>
    (futureDate.getTime() - base.getTime()) / 36e5; // milisekunde u sate

  /* ===== Scroll top bar ===== */
  useEffect(() => {
    const handleScroll = () => setScrolled(window.scrollY > 50);
    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);
async function applyPendingToEarliestAppt(db, phone, amount) {
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  const qAppt = query(
    collection(db, "appointments"),
    where("clientPhone", "==", phone),
    where("status", "==", "booked"),
    where("dateKey", ">=", todayKey),
    orderBy("dateKey", "asc"),
    orderBy("startMin", "asc")
  );

  const snap = await getDocs(qAppt);
  const first = snap.docs[0];
  if (!first) return;

  const apptRef = first.ref;
  const clientRef = doc(db, "clients", phone);

  await runTransaction(db, async (tx) => {
    const cSnap = await tx.get(clientRef);
    const cData = cSnap.exists() ? cSnap.data() : {};
    const pen = cData.pendingPenalty;
    if (!pen || Number(pen.amount || 0) <= 0) return;

    const aSnap = await tx.get(apptRef);
    if (!aSnap.exists()) return;
    if (aSnap.data()?.penaltyApplied?.amount > 0) return;

    tx.update(apptRef, {
      penaltyApplied: {
        amount: Number(pen.amount || amount || 0),
        sourceApptId: pen.sourceApptId || "",
        appliedAt: serverTimestamp(),
      },
      updatedAt: serverTimestamp(),
    });

    tx.set(
      clientRef,
      { pendingPenalty: deleteField(), updatedAt: serverTimestamp() },
      { merge: true }
    );
  });
}

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
    setHeroLoaded(false);
    setHeroHiResReady(false);
    document.body.classList.add("gallery-open");
  };
  const closeGallery = () => {
    setGalleryOpen(false);
    document.body.classList.remove("gallery-open");
  };

  // Progressive load + preload susednih kada se promeni currentImage (dok je galerija otvorena)
  useEffect(() => {
    if (!galleryOpen) return;
    setHeroLoaded(false);
    setHeroHiResReady(false);

    const cur = galleryImages[currentImage];
    // Preload trenutne velike
    preloadImage(cur).then(() => setHeroHiResReady(true)).catch(() => {});

    // Preload suseda: next & prev
    const next = galleryImages[(currentImage + 1) % galleryImages.length];
    const prev =
      galleryImages[(currentImage - 1 + galleryImages.length) % galleryImages.length];
    preloadImage(next).catch(() => {});
    preloadImage(prev).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [galleryOpen, currentImage]);

  /* ===== Cancel modal scroll lock ===== */
  useEffect(() => {
    if (cancelModalOpen) {
      document.body.classList.add("gallery-open");
    } else {
      document.body.classList.remove("gallery-open");
    }
    return () => document.body.classList.remove("gallery-open");
  }, [cancelModalOpen]);

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

  /* ===== Moji budući termini (za dugme "Otkaži termin") ===== */
  useEffect(() => {
    if (!isLoggedIn || !user?.phone) {
      setMyAppointments([]);
      return;
    }

    // Čitamo samo "booked" statuse za ovog korisnika
    const qAppt = query(
      collection(db, "appointments"),
      where("clientPhone", "==", user.phone),
      where("status", "==", "booked")
    );

    const unsub = onSnapshot(qAppt, (snap) => {
      const now = new Date();
      const future = [];
      snap.forEach((d) => {
        const a = d.data();
        if (!a?.dateKey || !a?.startHHMM) return;
        const dateObj = dateKeyTimeToLocalDate(a.dateKey, a.startHHMM);
        if (dateObj > now) {
          future.push({ id: d.id, ...a, dateObj });
        }
      });

      // sortiraj po najskorijem
      future.sort((x, y) => x.dateObj - y.dateObj);
      setMyAppointments(future);
    });

    return unsub;
  }, [isLoggedIn, user?.phone]);
/* ===== Moji PROŠLI termini (poslednjih 5) ===== */
useEffect(() => {
  if (!isLoggedIn || !user?.phone) {
    setPastAppointments([]);
    return;
  }

const qPast = query(
  collection(db, "appointments"),
  where("clientPhone", "==", user.phone),
  orderBy("dateKey", "desc"),
  orderBy("startMin", "desc")
);


  const unsub = onSnapshot(qPast, (snap) => {
    const now = new Date();
    const past = [];

    snap.forEach((d) => {
      const a = d.data();
      if (!a?.dateKey || !a?.startHHMM) return;

      const dateObj = new Date(`${a.dateKey}T${a.startHHMM}`);
      if (dateObj < now) {
        past.push({ id: d.id, ...a, dateObj });
      }
    });

    setPastAppointments(past.slice(0, 5));
  });

  return unsub;
}, [isLoggedIn, user?.phone]);

  async function cancelAppointment(appt) {
    try {
      const hours = diffHours(appt.dateObj, new Date());
      const lateCancel = hours < 6; // manje od 6 sati do termina

      // 1) Obeleži termin kao otkazan
      await updateDoc(doc(db, "appointments", appt.id), {
        status: "cancelled",
        cancelledAt: new Date(),
        lateCancel,
      });
      // 1b) NOTIF za otkazivanje — isti URL pattern i isti format startText kao kod "novi termin"
try {
  const dateText = new Intl.DateTimeFormat("sr-RS", {
    weekday: "short", day: "2-digit", month: "short"
  }).format(appt.dateObj);
  const startText = `${dateText} ${appt.startHHMM}`;

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(window.location.origin);
  const url = isLocal
    ? "https://abeauty.im/api/notify-admins-cancelled-appointment"
    : "/api/notify-admins-cancelled-appointment";

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      apptId: appt.id,
      clientName: (user?.firstName || "").trim(),
      clientPhone: user?.phone || "",
      serviceName: appt.serviceName || "",
      startText,
      screen: "/admin/kalendar",
      dateKey: appt.dateKey || "",
      employeeId: appt.employeeId || "",
      employeeName: appt.employeeName || "",
      startMin: appt.startMin ?? "",
    }),
  });

  const txt = await resp.text();
  console.log("notify-cancelled response:", resp.status, txt);
} catch (e) {
  console.warn("Notify cancelled-appointment failed:", e);
}


      // 2) Ako je <6h: transakcijski — upiši pending samo ako ne postoji,
      //    zatim pokušaj odmah da ga zakačiš na najbliži budući termin
      if (lateCancel && user?.phone) {
        const phoneKey = normPhone(user.phone);
      const basePrice = Number(appt.price ?? 0);
       const penaltyAmount = Math.round(basePrice * 0.5);

       const created = await runTransaction(db, async (tx) => {
          const cRef = doc(db, "clients", phoneKey);
         const snap = await tx.get(cRef);
         const data = snap.exists() ? snap.data() : {};
          const hasActive =
           data.pendingPenalty && Number(data.pendingPenalty.amount || 0) > 0;
         if (hasActive) return 0;
         tx.set(
           cRef,
           {
             phone: phoneKey,
             name: user.firstName || "",
             pendingPenalty: {
               amount: penaltyAmount,
               sourceApptId: appt.id,
               sourceService: appt.serviceName || "",
               createdAt: serverTimestamp(),
             },
             updatedAt: serverTimestamp(),
              createdAt: snap.exists()
                ? (data.createdAt || serverTimestamp())
                : serverTimestamp(),
            },
            { merge: true }
          );
          return penaltyAmount;
        });

     if (created > 0) {
         await applyPendingToEarliestAppt(db, phoneKey, created);
       }
   }

      alert(
        lateCancel
          ? "Termin je otkazan. 50% iznosa biće naplaćeno pri sledećem terminu."
          : "Termin je otkazan bez naplate."
      );
      setCancelModalOpen(false);
    } catch (e) {
      console.error(e);
      alert("Greška pri otkazivanju termina.");
    }
  }

  /* ===== Dugmad ===== */
  const goUsluge = () => {
    openServices(); // read-only modal
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

        {/* DODATO: Otkaži termin (vidljivo samo za korisnika koji nije admin i ima buduće termine) */}
        {isLoggedIn && !user?.isAdmin && myAppointments.length > 0 && (
          <button className="cancel-btn" onClick={() => setCancelModalOpen(true)}>
            Budući termin (Otkaži termin)
          </button>
        )}
        {isLoggedIn && !user?.isAdmin && pastAppointments.length > 0 && (
  <button
    className="custom-btn"
    style={{
      position: "absolute",
      left: "50%",
      top: "calc(50% + 170px)",
      transform: "translate(-50%, -50%)",
      fontSize: "1rem",
    }}
    onClick={() => setPastModalOpen(true)}
  >
    Prošli termini
  </button>
)}

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

            <div className="gallery-stage" style={{ position: "relative" }}>
              {/* low-res preview (thumb) */}
              <img
                className="gallery-image"
                src={toThumb(galleryImages[currentImage])}
                alt={`Slika ${currentImage + 1} (preview)`}
                loading="eager"
                style={{
                  position: "absolute",
                  inset: 0,
                  width: "100%",
                  height: "100%",
                  objectFit: "contain",
                  filter: heroHiResReady ? "blur(0px)" : "blur(12px)",
                  transition: "filter .35s ease",
                }}
                onError={(e) => {
                  // ako nema thumb-a, fallback na veliku
                  e.currentTarget.src = galleryImages[currentImage];
                }}
              />

              {/* hi-res image (fade-in kad se učita) */}
              <img
                className="gallery-image"
                src={galleryImages[currentImage]}
                alt={`Slika ${currentImage + 1}`}
                onLoad={() => setHeroLoaded(true)}
                style={{
                  opacity: heroLoaded ? 1 : 0,
                  transition: "opacity .35s ease",
                  position: "relative",
                  zIndex: 1,
                  display: "block",
                  margin: "0 auto",
                  maxWidth: "100%",
                  maxHeight: "70vh",
                  objectFit: "contain",
                }}
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

            {/* Filmstrip sa lazy thumbovima */}
            <div
              className="gallery-thumbs"
              style={{
                marginTop: 8,
                display: "flex",
                gap: 8,
                overflowX: "auto",
                padding: "6px 2px",
              }}
            >
              {galleryImages.map((src, i) => (
                <LazyThumb
                  key={src}
                  src={src}
                  alt={`Sličica ${i + 1}`}
                  isActive={i === currentImage}
                  onClick={() => setCurrentImage(i)}
                />
              ))}
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
                            {s.duration ? (
                              <span className="svc2-dur">{dur(s.duration)}</span>
                            ) : null}
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

            <div className="services2-footer"></div>
          </div>
        </div>
      )}

      {/* CANCEL MODAL – NOVI DIZAJN */}
      {cancelModalOpen && (
        <div
          className="gallery-overlay overlay--top"
          onClick={() => setCancelModalOpen(false)}
        >
          <div
            className="cancel-dialog"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Moji termini"
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0 }}>Moji termini</h3>
              <button className="gallery-close" onClick={() => setCancelModalOpen(false)} aria-label="Zatvori">
                ✕
              </button>
            </div>

            <p style={{ marginTop: 0, marginBottom: 8, fontSize: 13, lineHeight: 1.4 }}>
              Besplatno otkazivanje je moguće do <b>6 sati</b> pre termina. Nakon toga,
              biće naplaćeno <b>50%</b> iznosa pri sledećem zakazivanju.
            </p>

            {!myAppointments.length ? (
              <div style={{ opacity: 0.8 }}>Nema budućih termina.</div>
            ) : (
              <div className="cancel-list">
                {myAppointments.map((a) => {
                  const dstr = new Intl.DateTimeFormat("sr-RS", {
                    weekday: "short",
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  }).format(a.dateObj);
                  const hoursLeft = Math.max(0, Math.floor(diffHours(a.dateObj)));
                  return (
                    <div key={a.id} className="cancel-card">
                      <div>
                        <div style={{ fontWeight: 800 }}>
                          {dstr} u {a.startHHMM} — {a.serviceName || "Usluga"}
                        </div>
                        <div style={{ fontSize: 12, opacity: 0.8 }}>
                          {a.employeeName ? `Radnica: ${a.employeeName}` : ""}
                          {a.price ? ` • Cena: ${money(a.price)}` : ""}
                          {` • Preostalo ~ ${hoursLeft}h`}
                        </div>
                      </div>
                      <button
                        onClick={() => cancelAppointment(a)}
                        style={{
                          background: "#ff6b81",
                          color: "#fff",
                          border: "none",
                          borderRadius: 10,
                          padding: "8px 12px",
                          cursor: "pointer",
                          fontWeight: 700,
                        }}
                      >
                        Otkaži
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
{/* PAST APPOINTMENTS MODAL */}
{pastModalOpen && (
  <div
    className="gallery-overlay overlay--top"
    onClick={() => setPastModalOpen(false)}
  >
    <div
      className="cancel-dialog"
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Prošli termini</h3>
        <button
          className="gallery-close"
          onClick={() => setPastModalOpen(false)}
        >
          ✕
        </button>
      </div>

      {!pastAppointments.length ? (
        <div style={{ opacity: 0.7 }}>Nema prošlih termina.</div>
      ) : (
        <div className="cancel-list">
          {pastAppointments.map((a) => {
            const dstr = new Intl.DateTimeFormat("sr-RS", {
              weekday: "short",
              day: "2-digit",
              month: "2-digit",
              year: "numeric",
            }).format(a.dateObj);

            return (
              <div key={a.id} className="cancel-card">
                <div>
                  <div style={{ fontWeight: 800 }}>
                    {dstr} u {a.startHHMM}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    {a.serviceName} • {a.employeeName}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.6 }}>
                    Status: {a.status === "cancelled" ? "Otkazan" : "Završen"}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
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

/* ======================= POMOĆNE FUNKCIJE VAN KOMPONENTE ======================= */

// ---- Gallery helpers (van komponente kako bi ih koristile i LazyThumb i Home) ----
function toThumb(url) {
  if (!url) return url;
  try {
    const u = new URL(url, window.location.origin);
    const parts = u.pathname.split("/");
    const last = parts.pop();
    return ["/thumbs", ...parts.filter(Boolean).slice(0, -0), last].join("/");
  } catch {
    return url.replace(/(\.[a-zA-Z]+)$/, "_thumb$1");
  }
}

function preloadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(true);
    img.onerror = rej;
    img.src = src;
    img.decoding = "async";
    img.loading = "eager";
  });
}

// Normalizacija broja telefona: 06xx -> +3816xx, uklanja razmake, crtice itd.
function normPhone(p) {
  return String(p || "")
    .replace(/[^\d+]/g, "")
    .replace(/^00/, "+")
    .replace(/^0(6\d+)/, "+381$1");
}
