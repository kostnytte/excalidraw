import React from "react";
import type { AppProps } from "../types";

export const UIOptionsContext = React.createContext<AppProps["UIOptions"]>(
  null!,
);
export const useUIOptions = () => React.useContext(UIOptionsContext);
