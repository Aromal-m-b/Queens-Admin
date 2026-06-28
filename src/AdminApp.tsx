import { useState, useEffect } from "react";
import { BOARDS, Board } from "./data/boards";
import AdminPortal from "./components/AdminPortal";
import GeneratorPortal from "./components/GeneratorPortal";

export default function AdminApp() {
  const [allBoards, setAllBoards] = useState<Board[]>([]);
  const [isMuted] = useState(false);
  const [activeTab, setActiveTab] = useState<"designer" | "generator">("designer");

  // Load levels on initial mount
  useEffect(() => {
    try {
      const savedLevels = localStorage.getItem("queens-puzzle-all-boards-v1");
      let boardsLoaded: Board[] = [];
      if (savedLevels) {
        boardsLoaded = JSON.parse(savedLevels);
        setAllBoards(boardsLoaded);
      } else {
        boardsLoaded = BOARDS;
        setAllBoards(BOARDS);
      }
      syncLevelsWithServer(boardsLoaded);
    } catch (e) {
      console.error("Failed to load custom levels", e);
      setAllBoards(BOARDS);
      syncLevelsWithServer(BOARDS);
    }
  }, []);

  const syncLevelsWithServer = async (currentBoards: Board[]) => {
    try {
      const clientLevels = currentBoards.map((b) => ({
        id: b.id,
        updatedAt: b.updatedAt || 1718919020000,
      }));

      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientLevels }),
      });

      if (!res.ok) throw new Error("Sync network error");
      const data = await res.json();
      
      if (data.success) {
        const { toUpsert, toDelete } = data;
        if (toUpsert.length > 0 || toDelete.length > 0) {
          console.log(`Incremental sync: ${toUpsert.length} updates, ${toDelete.length} deletes.`);
          let updatedBoards = [...currentBoards];

          if (toDelete.length > 0) {
            updatedBoards = updatedBoards.filter((b) => !toDelete.includes(b.id));
          }

          toUpsert.forEach((ub: Board) => {
            const index = updatedBoards.findIndex((b) => b.id === ub.id);
            if (index !== -1) {
              updatedBoards[index] = ub;
            } else {
              updatedBoards.push(ub);
            }
          });

          const difficultyOrder = { easy: 1, medium: 2, hard: 3 };
          updatedBoards.sort((a, b) => {
            const aDiff = difficultyOrder[a.difficulty] || 99;
            const bDiff = difficultyOrder[b.difficulty] || 99;
            if (aDiff !== bDiff) return aDiff - bDiff;
            const aNum = parseInt(a.id.split("-").pop() || "0", 10);
            const bNum = parseInt(b.id.split("-").pop() || "0", 10);
            return aNum - bNum;
          });

          setAllBoards(updatedBoards);
          localStorage.setItem("queens-puzzle-all-boards-v1", JSON.stringify(updatedBoards));
        } else {
          console.log("Client local boards are fully synchronized.");
        }
      }
    } catch (err) {
      console.error("Incremental sync with server failed:", err);
    }
  };

  const saveBoardsState = async (newBoards: Board[]) => {
    const previousBoards = [...allBoards];
    setAllBoards(newBoards);
    try {
      localStorage.setItem("queens-puzzle-all-boards-v1", JSON.stringify(newBoards));
    } catch (e) {
      console.error("Failed to save levels", e);
    }

    try {
      const oldMap = new Map(previousBoards.map((b) => [b.id, b]));
      const newMap = new Map(newBoards.map((b) => [b.id, b]));

      const deletedIds: string[] = [];
      previousBoards.forEach((ob) => {
        if (!newMap.has(ob.id)) {
          deletedIds.push(ob.id);
        }
      });

      const upsertBoards: Board[] = [];
      newBoards.forEach((nb) => {
        const ob = oldMap.get(nb.id);
        if (!ob) {
          upsertBoards.push({ ...nb, updatedAt: nb.updatedAt || Date.now() });
        } else {
          const gridStr = JSON.stringify(ob.grid) !== JSON.stringify(nb.grid);
          const solStr = JSON.stringify(ob.solution) !== JSON.stringify(nb.solution);
          const colStr = JSON.stringify(ob.colors) !== JSON.stringify(nb.colors);
          const timeStr = ob.updatedAt !== nb.updatedAt;
          if (gridStr || solStr || colStr || timeStr) {
            upsertBoards.push({ ...nb, updatedAt: nb.updatedAt || Date.now() });
          }
        }
      });

      for (const id of deletedIds) {
        fetch(`/api/boards/${id}`, { method: "DELETE" })
          .then((r) => r.json())
          .then((data) => console.log(`Deleted level ${id} from MongoDB:`, data))
          .catch((err) => console.error(`Error deleting ${id}:`, err));
      }

      for (const board of upsertBoards) {
        fetch("/api/boards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(board),
        })
          .then((r) => r.json())
          .then((data) => console.log(`Upserted level ${board.id} to MongoDB:`, data))
          .catch((err) => console.error(`Error upserting ${board.id}:`, err));
      }
    } catch (err) {
      console.error("MongoDB push failed:", err);
    }
  };

  const playChime = (type: "dot" | "queen" | "clear" | "win" | "hint" | "error" | "click") => {
    if (isMuted) return;
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      
      if (type === "click" || type === "dot") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(450, ctx.currentTime);
        gain.gain.setValueAtTime(0.04, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.12);
      } else if (type === "error") {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(140, ctx.currentTime);
        osc.frequency.setValueAtTime(110, ctx.currentTime + 0.08);
        gain.gain.setValueAtTime(0.03, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.25);
      }
    } catch (e) {
      // AudioContext blocked
    }
  };

  return (
    <div className="bg-[#f1f2f6] text-[#2d3436] min-h-screen w-full flex flex-col items-center select-none font-sans relative transition-all" id="admin-workspace-theme-root">
      {/* Isolated Designer Header */}
      <header className="w-full px-6 py-4 flex flex-col sm:flex-row items-center justify-between gap-4 border-b-4 border-[#2d3436] bg-[#2d3436] text-white shrink-0 shadow-lg">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-[#6c5ce7] flex items-center justify-center text-white font-black">
            ⚙️
          </div>
          <div>
            <h1 className="font-display font-black text-lg tracking-wider text-white uppercase leading-none">
              QUEENS BUILDER
            </h1>
            <p className="text-[9px] text-[#a29bfe] font-bold tracking-widest uppercase leading-none mt-1">
              Level designer workspace
            </p>
          </div>
        </div>

        {/* Tab switcher */}
        <div className="flex items-center gap-2 bg-[#2d3436] border-2 border-white/20 p-1 rounded-xl">
          <button
            onClick={() => setActiveTab("designer")}
            className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === "designer"
                ? "bg-white text-[#2d3436] font-extrabold shadow-sm"
                : "text-white/60 hover:text-white"
            }`}
          >
            🎨 Designer
          </button>
          <button
            onClick={() => setActiveTab("generator")}
            className={`px-4 py-1.5 rounded-lg text-xs font-black uppercase tracking-wider transition-all cursor-pointer ${
              activeTab === "generator"
                ? "bg-white text-[#2d3436] font-extrabold shadow-sm"
                : "text-white/60 hover:text-white"
            }`}
          >
            ⚙️ Generator
          </button>
        </div>
      </header>

      <main className="w-full px-4 sm:px-6 flex-grow flex flex-col items-center justify-start py-4 sm:py-8">
        {activeTab === "designer" ? (
          <AdminPortal
            onClose={() => {}}
            allBoards={allBoards}
            onSaveBoards={saveBoardsState}
            playChime={playChime}
          />
        ) : (
          <GeneratorPortal />
        )}
      </main>
    </div>
  );
}
