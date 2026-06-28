import express from "express";
import path from "path";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import { createServer as createViteServer } from "vite";

// Load environment variables
dotenv.config();

const PORT = 3000;
const app = express();
app.use(express.json());

// MongoDB URI matching existing workspace connection string
const mongoUri = process.env.MONGODB_URI || "mongodb+srv://agent:aromal@queens-dev.u1uyh5l.mongodb.net/?appName=Queens-Dev";
const dbName = "queens-dev";
const collectionName = "levels";

let mongoClient: MongoClient | null = null;

async function getDb() {
  if (!mongoClient) {
    try {
      mongoClient = new MongoClient(mongoUri, {
        connectTimeoutMS: 5000,
        socketTimeoutMS: 30000,
      });
      await mongoClient.connect();
      console.log("[Admin Service] Connected to MongoDB Atlas successfully");
    } catch (err) {
      console.error("[Admin Service] MongoDB Connection error:", err);
      mongoClient = null;
      throw err;
    }
  }
  return mongoClient.db(dbName);
}

// Help parse difficulty dynamically via string slicing
function getDifficultyFromId(id: string): "easy" | "medium" | "hard" {
  const sliced = id.slice(0, -2);
  if (sliced === "easy" || sliced === "easy-") return "easy";
  if (sliced === "medium" || sliced === "medium-") return "medium";
  if (sliced === "hard" || sliced === "hard-") return "hard";
  
  const parts = id.split("-");
  if (parts.length > 0) {
    const p = parts[0];
    if (p === "easy" || p === "medium" || p === "hard") return p as any;
  }
  return "easy";
}

function cleanLevelForDb(level: any) {
  const clean = { ...level };
  delete clean._id;
  delete clean.difficulty;
  return clean;
}

function mapDbLevelToClient(level: any) {
  const clean = { ...level };
  delete clean._id;
  clean.difficulty = getDifficultyFromId(level.id);
  return clean;
}

// API: List custom boards
app.get("/api/boards", async (_req, res) => {
  try {
    const db = await getDb();
    const boards = await db.collection(collectionName).find({}).toArray();
    res.json(boards.map(mapDbLevelToClient));
  } catch (err: any) {
    console.error("Error retrieving boards:", err);
    res.status(500).json({ error: "Failed to retrieve boards", details: err?.message });
  }
});

// API: Sync custom boards incrementally
app.post("/api/sync", async (req, res) => {
  try {
    const { clientLevels } = req.body;
    const clientLevelsList = Array.isArray(clientLevels) ? clientLevels : [];
    
    const db = await getDb();
    const dbLevels = await db.collection(collectionName).find({}).toArray();

    const dbLevelsMap = new Map<string, any>();
    dbLevels.forEach((level) => {
      const cleanLevel = mapDbLevelToClient(level);
      dbLevelsMap.set(level.id, cleanLevel);
    });

    const toUpsert: any[] = [];
    const toDelete: string[] = [];

    dbLevelsMap.forEach((dbLevel, id) => {
      const clientPair = clientLevelsList.find((pair: any) => pair.id === id);
      if (!clientPair) {
        toUpsert.push(dbLevel);
      } else {
        const dbUpdatedAt = dbLevel.updatedAt || 0;
        const clientUpdatedAt = clientPair.updatedAt || 0;
        if (dbUpdatedAt > clientUpdatedAt) {
          toUpsert.push(dbLevel);
        }
      }
    });

    clientLevelsList.forEach((clientPair: any) => {
      if (!dbLevelsMap.has(clientPair.id)) {
        toDelete.push(clientPair.id);
      }
    });

    res.json({
      toUpsert,
      toDelete,
      success: true
    });
  } catch (err: any) {
    console.error("Synchronization failed:", err);
    res.status(500).json({ error: "Sync failed", details: err?.message });
  }
});

// API: Upsert board (saves or edits a boards)
app.post("/api/boards", async (req, res) => {
  try {
    const board = req.body;
    if (!board.id || !board.size || !board.grid || !board.solution) {
      return res.status(400).json({ error: "Missing required board configuration fields" });
    }

    board.updatedAt = Date.now();
    const dbPayload = cleanLevelForDb(board);

    const db = await getDb();
    await db.collection(collectionName).updateOne(
      { id: board.id },
      { $set: dbPayload },
      { upsert: true }
    );

    res.status(201).json({ success: true, board: mapDbLevelToClient(dbPayload) });
  } catch (err: any) {
    console.error("Failed to save board:", err);
    res.status(500).json({ error: "Failed to save board", details: err?.message });
  }
});

// API: Edit existing board attributes
app.put("/api/boards/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    updates.updatedAt = Date.now();
    const dbPayload = cleanLevelForDb(updates);

    const db = await getDb();
    const result = await db.collection(collectionName).updateOne(
      { id },
      { $set: dbPayload }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ error: "Board not found" });
    }

    res.json({ success: true, id, updates: mapDbLevelToClient(dbPayload) });
  } catch (err: any) {
    console.error("Failed to update board:", err);
    res.status(500).json({ error: "Failed to update board", details: err?.message });
  }
});

// API: Deletes custom boards
app.delete("/api/boards/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const db = await getDb();
    const result = await db.collection(collectionName).deleteOne({ id });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Board not found" });
    }

    res.json({ success: true, id });
  } catch (err: any) {
    console.error("Failed to delete board:", err);
    res.status(500).json({ error: "Failed to delete board", details: err?.message });
  }
});

// Serve frontend assets via Vite in development, static files in production
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[Admin Service] Running locally on http://localhost:${PORT}`);
  });
}

startServer();
