"""User playlists CRUD."""
import uuid

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
from database import (
    get_playlists, create_playlist, rename_playlist, delete_playlist,
    add_track_to_playlist, remove_track_from_playlist, reorder_playlist_tracks,
)

router = APIRouter(tags=["playlists"])


@router.get("/api/playlists")
async def list_playlists(current_user: dict = Depends(get_current_user)):
    return {"playlists": get_playlists(current_user["id"])}


@router.post("/api/playlists")
async def create_playlist_endpoint(payload: dict, current_user: dict = Depends(get_current_user)):
    name = payload.get("name", "").strip()
    if not name:
        raise HTTPException(400, "name required")
    playlist_id = str(uuid.uuid4())
    create_playlist(current_user["id"], playlist_id, name)
    return {"id": playlist_id, "name": name, "tracks": []}


@router.patch("/api/playlists/{playlist_id}")
async def rename_playlist_endpoint(playlist_id: str, payload: dict, current_user: dict = Depends(get_current_user)):
    name = payload.get("name", "").strip()
    if not name:
        raise HTTPException(400, "name required")
    rename_playlist(current_user["id"], playlist_id, name)
    return {"ok": True}


@router.delete("/api/playlists/{playlist_id}")
async def delete_playlist_endpoint(playlist_id: str, current_user: dict = Depends(get_current_user)):
    delete_playlist(current_user["id"], playlist_id)
    return {"ok": True}


@router.post("/api/playlists/{playlist_id}/tracks")
async def add_track_to_playlist_endpoint(playlist_id: str, payload: dict, current_user: dict = Depends(get_current_user)):
    track = payload.get("track")
    position = payload.get("position", 0)
    if not track:
        raise HTTPException(400, "track required")
    add_track_to_playlist(playlist_id, track, position)
    return {"ok": True}


@router.delete("/api/playlists/{playlist_id}/tracks/{track_key:path}")
async def remove_track_from_playlist_endpoint(playlist_id: str, track_key: str, current_user: dict = Depends(get_current_user)):
    remove_track_from_playlist(playlist_id, track_key)
    return {"ok": True}


@router.put("/api/playlists/{playlist_id}/tracks")
async def reorder_playlist_tracks_endpoint(playlist_id: str, payload: dict, current_user: dict = Depends(get_current_user)):
    tracks = payload.get("tracks", [])
    reorder_playlist_tracks(playlist_id, tracks)
    return {"ok": True}
