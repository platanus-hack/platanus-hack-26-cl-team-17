"use client";
/** Captura errores del lienzo 3D (o de la carga de su código) para caer a la planta 2D. */
import { Component, type ReactNode } from "react";

interface Props {
  onError: (error: unknown) => void;
  children: ReactNode;
}

export class ViewerErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
