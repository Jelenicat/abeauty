// src/context/AuthContext.jsx
import { createContext, useContext, useEffect, useState } from "react";
import { db } from "../firebase";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";

const AuthContext = createContext(null);
const ADMIN_PHONE = "0665511005"; // normalizovan oblik

function normalizePhone(p) {
  const digits = String(p || "").replace(/\D/g, ""); // skini sve nedigit karaktere
  return digits.replace(/^381/, "0"); // +381xx -> 0xx
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const raw = localStorage.getItem("abeauty:user");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (user) localStorage.setItem("abeauty:user", JSON.stringify(user));
    else localStorage.removeItem("abeauty:user");
  }, [user]);

  // upis u Firestore + role = admin|client
  const login = async ({ firstName, lastName, phone }) => {
    const fn = String(firstName || "").trim();
    const ln = String(lastName || "").trim();
    const phoneNorm = normalizePhone(phone);

    const isAdmin = phoneNorm === ADMIN_PHONE;   // ⬅️ samo po broju
    const role = isAdmin ? "admin" : "client";

    const ref = doc(db, "users", phoneNorm);
    await setDoc(
      ref,
      {
        firstName: fn || null,
        lastName: ln || null,
        phone: phoneNorm,
        role,
        updatedAt: serverTimestamp(),
        // createdAt će se postaviti prvi put; ako dokument postoji, merge neće obrisati postojeći createdAt
        createdAt: serverTimestamp(),
      },
      { merge: true }
    );

    const sessionUser = {
      id: phoneNorm,
      firstName: fn,
      lastName: ln,
      phone: phoneNorm,
      role,
      isAdmin,
    };
    setUser(sessionUser);
    return sessionUser;
  };

  const logout = () => {
    try { localStorage.removeItem("abeauty:user"); } catch {}
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, isLoggedIn: !!user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
