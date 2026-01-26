import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { load } from "@tauri-apps/plugin-store";
import { Chart, registerables } from "chart.js";
import "./App.css";

Chart.register(...registerables);

// Default Brawlhalla servers
const DEFAULT_SERVERS = [
  { id: "us-e", name: "US-East", address: "pingtest-atl.brawlhalla.com" },
  { id: "us-w", name: "US-West", address: "pingtest-cal.brawlhalla.com" },
  { id: "eu", name: "Europe", address: "pingtest-ams.brawlhalla.com" },
  { id: "sea", name: "Southeast Asia", address: "pingtest-sgp.brawlhalla.com" },
  { id: "aus", name: "Australia", address: "pingtest-aus.brawlhalla.com" },
  { id: "brz", name: "Brazil", address: "pingtest-brs.brawlhalla.com" },
  { id: "jpn", name: "Japan", address: "pingtest-jpn.brawlhalla.com" },
  { id: "mde", name: "Middle East", address: "pingtest-mde.brawlhalla.com" },
  { id: "saf", name: "Southern Africa", address: "pingtest-saf.brawlhalla.com" },
];

const PING_COUNT = 100;

function ServerCard({ server, onToggleFavorite, onRemove, isCustom }) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState([]);
  const [stats, setStats] = useState({ avg: null, min: null, max: null, loss: 0 });
  const [timeouts, setTimeouts] = useState(0);
  const chartRef = useRef(null);
  const chartInstance = useRef(null);
  const canvasRef = useRef(null);

  // Calculate stats from results
  const updateStats = useCallback((newResults, newTimeouts) => {
    if (newResults.length === 0) {
      setStats({ avg: null, min: null, max: null, loss: 0 });
      return;
    }
    const total = newResults.length + newTimeouts;
    const avg = newResults.reduce((a, b) => a + b, 0) / newResults.length;
    const min = Math.min(...newResults);
    const max = Math.max(...newResults);
    const loss = total > 0 ? (newTimeouts / total) * 100 : 0;
    setStats({ avg, min, max, loss });
  }, []);

  // Initialize chart
  useEffect(() => {
    if (canvasRef.current && !chartInstance.current) {
      const ctx = canvasRef.current.getContext("2d");
      chartInstance.current = new Chart(ctx, {
        type: "line",
        data: {
          labels: [],
          datasets: [{
            label: "Latency (ms)",
            data: [],
            borderColor: "#3b82f6",
            backgroundColor: "rgba(59, 130, 246, 0.1)",
            borderWidth: 2,
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 4,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: {
            intersect: false,
            mode: "index",
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "rgba(0, 0, 0, 0.8)",
              titleColor: "#fff",
              bodyColor: "#fff",
              padding: 8,
              displayColors: false,
              callbacks: {
                label: (ctx) => `${ctx.parsed.y.toFixed(1)} ms`,
              },
            },
          },
          scales: {
            x: {
              display: false,
            },
            y: {
              beginAtZero: true,
              grid: {
                color: "rgba(255, 255, 255, 0.06)",
              },
              ticks: {
                color: "#6b7280",
                font: { size: 10 },
                callback: (value) => `${value}ms`,
              },
            },
          },
        },
      });
    }

    return () => {
      if (chartInstance.current) {
        chartInstance.current.destroy();
        chartInstance.current = null;
      }
    };
  }, []);

  // Update chart when results change
  useEffect(() => {
    if (chartInstance.current) {
      chartInstance.current.data.labels = results.map((_, i) => i + 1);
      chartInstance.current.data.datasets[0].data = results;
      chartInstance.current.update("none");
    }
  }, [results]);

  // Listen for ping events
  useEffect(() => {
    const unlisteners = [];

    const setupListeners = async () => {
      unlisteners.push(
        await listen("ping-result", (event) => {
          if (event.payload.server_id === server.id) {
            setResults((prev) => {
              const newResults = [...prev, event.payload.time_ms];
              updateStats(newResults, timeouts);
              return newResults;
            });
          }
        })
      );

      unlisteners.push(
        await listen("ping-timeout", (event) => {
          if (event.payload.server_id === server.id) {
            setTimeouts((prev) => {
              const newTimeouts = prev + 1;
              updateStats(results, newTimeouts);
              return newTimeouts;
            });
          }
        })
      );

      unlisteners.push(
        await listen("ping-complete", (event) => {
          if (event.payload.server_id === server.id) {
            setRunning(false);
          }
        })
      );

      unlisteners.push(
        await listen("ping-stopped", (event) => {
          if (event.payload.server_id === server.id) {
            setRunning(false);
          }
        })
      );
    };

    setupListeners();

    return () => {
      unlisteners.forEach((unlisten) => unlisten && unlisten());
    };
  }, [server.id, results, timeouts, updateStats]);

  const handleToggle = async () => {
    if (!running) {
      // Clear previous results
      setResults([]);
      setTimeouts(0);
      setStats({ avg: null, min: null, max: null, loss: 0 });
    }

    try {
      const started = await invoke("toggle_ping", {
        args: {
          server_id: server.id,
          address: server.address,
          count: PING_COUNT,
        },
      });
      setRunning(started);
    } catch (err) {
      console.error("Ping error:", err);
      setRunning(false);
    }
  };

  return (
    <div className={`server-card ${running ? "running" : ""} ${server.favorite ? "favorite" : ""}`}>
      <div className="card-header">
        <div className="server-info">
          <button
            className={`favorite-btn ${server.favorite ? "active" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFavorite(server.id);
            }}
            title={server.favorite ? "Remove from favorites" : "Add to favorites"}
          >
            {server.favorite ? "\u2605" : "\u2606"}
          </button>
          <div className="server-details">
            <h3 className="server-name">{server.name}</h3>
            <span className="server-address">{server.address}</span>
          </div>
        </div>
        <div className="card-actions">
          {isCustom && !running && (
            <button
              className="remove-btn"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(server.id);
              }}
              title="Remove server"
            >
              ×
            </button>
          )}
          <button
            className={`ping-btn ${running ? "pinging" : ""}`}
            onClick={handleToggle}
          >
            {running ? "Pinging" : "Ping"}
          </button>
        </div>
      </div>

      <div className="chart-container" ref={chartRef}>
        <canvas ref={canvasRef}></canvas>
      </div>

      <div className="stats-row">
        <div className="stat">
          <span className="stat-label">Avg</span>
          <span className="stat-value">{stats.avg !== null ? `${stats.avg.toFixed(1)}ms` : "-"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Min</span>
          <span className="stat-value">{stats.min !== null ? `${stats.min.toFixed(1)}ms` : "-"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Max</span>
          <span className="stat-value">{stats.max !== null ? `${stats.max.toFixed(1)}ms` : "-"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Loss</span>
          <span className={`stat-value ${stats.loss > 0 ? "loss-warning" : ""}`}>
            {stats.loss > 0 ? `${stats.loss.toFixed(1)}%` : "0%"}
          </span>
        </div>
      </div>
    </div>
  );
}

function AddServerModal({ onAdd, onClose }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    if (!address.trim()) {
      setError("Address is required");
      return;
    }

    // Basic validation for hostname/IP
    const addressPattern = /^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$|^[a-zA-Z0-9]$/;
    if (!addressPattern.test(address)) {
      setError("Invalid address format");
      return;
    }

    onAdd({
      id: `custom-${Date.now()}`,
      name: name.trim(),
      address: address.trim(),
      favorite: false,
      custom: true,
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add Custom Server</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label htmlFor="server-name">Server Name</label>
            <input
              id="server-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., My Server"
              autoFocus
            />
          </div>
          <div className="form-group">
            <label htmlFor="server-address">Hostname / IP</label>
            <input
              id="server-address"
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="e.g., ping.example.com"
            />
          </div>
          {error && <p className="error-message">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="cancel-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="add-btn">
              Add Server
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function App() {
  const [servers, setServers] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [storeLoaded, setStoreLoaded] = useState(false);
  const storeRef = useRef(null);

  // Load servers from store
  useEffect(() => {
    const loadStore = async () => {
      try {
        const store = await load("servers.json", { autoSave: true });
        storeRef.current = store;

        const savedServers = await store.get("servers");
        const savedFavorites = await store.get("favorites") || [];

        if (savedServers && Array.isArray(savedServers)) {
          // Merge saved with defaults, preserving favorites
          const serverMap = new Map();

          // Add defaults first
          DEFAULT_SERVERS.forEach((s) => {
            serverMap.set(s.id, { ...s, favorite: savedFavorites.includes(s.id) });
          });

          // Add/update with saved servers
          savedServers.forEach((s) => {
            if (s.custom) {
              serverMap.set(s.id, { ...s, favorite: savedFavorites.includes(s.id) });
            }
          });

          setServers(Array.from(serverMap.values()));
        } else {
          setServers(DEFAULT_SERVERS.map((s) => ({ ...s, favorite: false })));
        }
      } catch (err) {
        console.error("Failed to load store:", err);
        setServers(DEFAULT_SERVERS.map((s) => ({ ...s, favorite: false })));
      }
      setStoreLoaded(true);
    };

    loadStore();
  }, []);

  // Save servers to store when they change
  useEffect(() => {
    if (storeLoaded && storeRef.current) {
      const customServers = servers.filter((s) => s.custom);
      const favorites = servers.filter((s) => s.favorite).map((s) => s.id);

      storeRef.current.set("servers", customServers);
      storeRef.current.set("favorites", favorites);
    }
  }, [servers, storeLoaded]);

  const toggleFavorite = (serverId) => {
    setServers((prev) =>
      prev.map((s) =>
        s.id === serverId ? { ...s, favorite: !s.favorite } : s
      )
    );
  };

  const addServer = (server) => {
    setServers((prev) => [...prev, server]);
  };

  const removeServer = (serverId) => {
    setServers((prev) => prev.filter((s) => s.id !== serverId));
  };

  // Sort: favorites first, then by name
  const sortedServers = [...servers].sort((a, b) => {
    if (a.favorite !== b.favorite) return b.favorite ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className="app">
      <header className="app-header">
        <h1>Bob's Better Brawlhalla Ping Tester</h1>
        <button className="add-server-btn" onClick={() => setShowAddModal(true)}>
          + Add Server
        </button>
      </header>

      <main className="server-list">
        {sortedServers.map((server) => (
          <ServerCard
            key={server.id}
            server={server}
            onToggleFavorite={toggleFavorite}
            onRemove={removeServer}
            isCustom={server.custom}
          />
        ))}
      </main>

      {showAddModal && (
        <AddServerModal
          onAdd={addServer}
          onClose={() => setShowAddModal(false)}
        />
      )}
    </div>
  );
}

export default App;
