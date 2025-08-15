import React, { useEffect, useState, useRef } from "react";
import { useAuth } from "../context/AuthContext";
import "./LoginModal.css";

export default function LoginModal({ open, onClose, onSuccess }) {
  const { login } = useAuth();
  const [firstName, setFirstName] = useState("");
  const [lastName,  setLastName]  = useState("");
  const [phone,     setPhone]     = useState("");
  const [touched,   setTouched]   = useState(false);
  const [loading,   setLoading]   = useState(false);
  const cardRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === "Escape" && onClose?.();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (open) setTimeout(() => cardRef.current?.querySelector("input")?.focus(), 0);
  }, [open]);

  if (!open) return null;

  // normalizacija u skladu sa AuthContext-om
  const phoneNorm = String(phone || "").replace(/\D/g, "").replace(/^381/, "0");
  const nameOk  = firstName.trim().length >= 2 && lastName.trim().length >= 2;
  const phoneOk = phoneNorm.length >= 8 && phoneNorm.length <= 11;
  const canSubmit = nameOk && phoneOk && !loading;

  const submit = async (e) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit) return;

    setLoading(true);
    try {
      const created = await login({
        firstName: firstName.trim(),
        lastName:  lastName.trim(),
        phone:     phoneNorm, // šaljemo već normalizovano
      });
      onClose?.();
      onSuccess?.(created);
    } catch (err) {
      console.error("Login save failed:", err);
      alert("Trenutno ne možemo da sačuvamo prijavu. Pokušaj ponovo.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="lm-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div className="lm-card" ref={cardRef} role="dialog" aria-modal="true" aria-labelledby="lm-title">
        <button className="lm-close" aria-label="Zatvori" onClick={onClose}>×</button>

        <div className="lm-header">
          <img src="/logo.png" alt="aBeauty" className="lm-logo" />
          <h3 id="lm-title">Popuni podatke da zakažeš termin</h3>
        </div>

        <form className="lm-form" onSubmit={submit} noValidate>
          <label className="lm-field">
            <span>Ime</span>
            <input
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="npr. Ana"
              autoComplete="given-name"
            />
            {touched && firstName.trim().length < 2 && <em>Unesi bar 2 slova.</em>}
          </label>

          <label className="lm-field">
            <span>Prezime</span>
            <input
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="npr. Petrović"
              autoComplete="family-name"
            />
            {touched && lastName.trim().length < 2 && <em>Unesi bar 2 slova.</em>}
          </label>

          <label className="lm-field">
            <span>Telefon</span>
            <input
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="npr. 060 123 4567"
              autoComplete="tel"
            />
            {touched && !phoneOk && <em>Unesi ispravan broj (8–11 cifara).</em>}
          </label>

          <button className="lm-submit" type="submit" disabled={!canSubmit}>
            {loading ? "Sačuvano" : "Nastavi i zakaži"}
          </button>
        </form>
      </div>
    </div>
  );
}
