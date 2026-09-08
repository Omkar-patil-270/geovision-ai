import "./cesiumConfig";
import { Component } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.jsx";

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("GeoVisionAI caught application error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: "radial-gradient(circle at 50% 50%, #0c1427 0%, #050811 100%)",
          color: "#f1f5f9",
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
          padding: "24px",
          textAlign: "center"
        }}>
          <div style={{
            background: "rgba(15, 23, 42, 0.85)",
            backdropFilter: "blur(20px)",
            border: "1px solid rgba(0, 212, 255, 0.3)",
            borderRadius: "16px",
            padding: "36px 48px",
            maxWidth: "520px",
            boxShadow: "0 20px 50px rgba(0,0,0,0.7)"
          }}>
            <div style={{ fontSize: "40px", marginBottom: "16px" }}>🌍</div>
            <h1 style={{ fontSize: "22px", fontWeight: "700", marginBottom: "8px", color: "#00d4ff" }}>
              GeoVisionAI Intelligence Platform
            </h1>
            <p style={{ color: "#94a3b8", fontSize: "14px", lineHeight: "1.6", marginBottom: "24px" }}>
              The application encountered a runtime issue during initialization. You can reload the workspace or relaunch with default settings.
            </p>
            {this.state.error?.message && (
              <div style={{
                background: "rgba(239, 68, 68, 0.1)",
                border: "1px solid rgba(239, 68, 68, 0.25)",
                borderRadius: "8px",
                padding: "10px 14px",
                color: "#f87171",
                fontSize: "12px",
                fontFamily: "monospace",
                marginBottom: "20px",
                textAlign: "left",
                wordBreak: "break-word"
              }}>
                {this.state.error.message}
              </div>
            )}
            <button
              onClick={() => { window.location.reload(); }}
              style={{
                background: "linear-gradient(135deg, #00d4ff, #3b82f6)",
                border: "none",
                borderRadius: "999px",
                color: "#ffffff",
                padding: "12px 28px",
                fontSize: "14px",
                fontWeight: "600",
                cursor: "pointer",
                boxShadow: "0 4px 16px rgba(0, 212, 255, 0.4)"
              }}
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);