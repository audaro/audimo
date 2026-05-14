#!/bin/bash
set -e

# Kill any existing instances first
echo "🧹 Cleaning up any existing processes..."
pkill -f "uvicorn main:app" 2>/dev/null || true
pkill -f "vite" 2>/dev/null || true
sleep 1

echo "🎵 Starting Audimo Music App..."
echo ""

# Backend
echo "→ Setting up Python backend..."
cd backend

if [ ! -d "venv" ]; then
  python3 -m venv venv
  echo "  Created virtual environment"
fi

. venv/bin/activate
pip install -r requirements.txt -q
echo "  Dependencies installed"

cp -n .env.example .env 2>/dev/null || true

echo "  Starting FastAPI on http://localhost:8000"
uvicorn main:app --reload --port 8000 &
BACKEND_PID=$!
cd ..

# Frontend
echo "→ Setting up frontend..."
cd frontend
if [ ! -d "node_modules" ]; then
  echo "  Installing npm packages (first run only)..."
  npm install
fi
echo "  Starting Vite dev server on http://localhost:5173"
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "✅ Audimo is running!"
echo "   App:      http://localhost:5173"
echo "   API:      http://localhost:8000"
echo "   API Docs: http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop"
echo ""

# Trap Ctrl+C and kill both processes + their children
cleanup() {
  echo ""
  echo "🛑 Stopping Audimo..."
  # Kill process groups to catch child processes too
  kill -TERM -$BACKEND_PID 2>/dev/null || kill -9 $BACKEND_PID 2>/dev/null || true
  kill -TERM -$FRONTEND_PID 2>/dev/null || kill -9 $FRONTEND_PID 2>/dev/null || true
  # Also kill by port in case anything is lingering
  kill -9 $(lsof -ti:8000) 2>/dev/null || true
  kill -9 $(lsof -ti:5173) 2>/dev/null || true
  echo "✓ Stopped"
  exit 0
}

trap cleanup INT TERM

wait $BACKEND_PID $FRONTEND_PID
