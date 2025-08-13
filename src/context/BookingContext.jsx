import { createContext, useContext, useEffect, useState } from "react";

const BookingCtx = createContext(null);

export function BookingProvider({ children }) {
  const [selectedServices, setSelectedServices] = useState(() => {
    try { return JSON.parse(localStorage.getItem("abeauty:selServices")||"[]"); } catch { return []; }
  });

  useEffect(() => {
    localStorage.setItem("abeauty:selServices", JSON.stringify(selectedServices||[]));
  }, [selectedServices]);

  return (
    <BookingCtx.Provider value={{ selectedServices, setSelectedServices }}>
      {children}
    </BookingCtx.Provider>
  );
}
export const useBooking = () => useContext(BookingCtx);
