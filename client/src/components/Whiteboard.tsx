import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, MousePointer2, PenLine, RotateCcw, Trash2, Type, ZoomIn, ZoomOut } from 'lucide-react';
import type { Socket } from 'socket.io-client';

type Point = { x: number; y: number };
type Stroke = { id: string; type?: 'draw' | 'text'; text?: string; tool: 'pen' | 'eraser'; color: string; width: number; points: Point[]; ownerName?: string; ownerId?: string };
type Tool = 'pen' | 'eraser' | 'text';
type TextEntry = { point: Point; value: string };
const BOARD_WIDTH = 1600;
const BOARD_HEIGHT = 900;

export default function Whiteboard({ socket, participantId, canClear }: { socket: Socket | null; participantId: string; canClear: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const pointsRef = useRef<Point[]>([]);
  const liveStrokeRef = useRef<Stroke | null>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState('#2563eb');
  const [width, setWidth] = useState(4);
  const [zoom, setZoom] = useState(100);
  const [status, setStatus] = useState('Shared with everyone in this classroom');
  const [textEntry, setTextEntry] = useState<TextEntry | null>(null);
  const cancelTextEntryRef = useRef(false);

  const render = useCallback((allStrokes: Stroke[], draft?: Stroke | null) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    ctx.fillStyle = '#fdfdfd'; ctx.fillRect(0, 0, BOARD_WIDTH, BOARD_HEIGHT);
    // A very light page grid makes handwritten notes easier to align without visual clutter.
    ctx.save(); ctx.strokeStyle = '#eff1f6'; ctx.lineWidth = 1;
    for (let x = 50; x < BOARD_WIDTH; x += 50) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, BOARD_HEIGHT); ctx.stroke(); }
    for (let y = 50; y < BOARD_HEIGHT; y += 50) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(BOARD_WIDTH, y); ctx.stroke(); }
    ctx.restore();
    [...allStrokes, ...(draft ? [draft] : [])].forEach((stroke) => {
      if (!stroke.points.length) return;
      if (stroke.type === 'text') {
        ctx.save(); ctx.fillStyle = stroke.color; ctx.font = `600 ${stroke.width * 5}px Manrope, Arial, sans-serif`;
        ctx.textBaseline = 'top'; ctx.fillText(stroke.text || '', stroke.points[0].x * BOARD_WIDTH, stroke.points[0].y * BOARD_HEIGHT, BOARD_WIDTH * .8); ctx.restore();
        return;
      }
      ctx.save(); ctx.strokeStyle = stroke.tool === 'eraser' ? '#fdfdfd' : stroke.color;
      ctx.lineWidth = stroke.width * (BOARD_WIDTH / 1000); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x * BOARD_WIDTH, stroke.points[0].y * BOARD_HEIGHT);
      if (stroke.points.length === 1) {
        const p = stroke.points[0]; ctx.lineTo(p.x * BOARD_WIDTH + 0.1, p.y * BOARD_HEIGHT + 0.1);
      } else stroke.points.slice(1).forEach((p) => ctx.lineTo(p.x * BOARD_WIDTH, p.y * BOARD_HEIGHT));
      ctx.stroke(); ctx.restore();
    });
  }, []);

  useEffect(() => { render(strokes); }, [strokes, render]);
  useEffect(() => {
    if (!socket) return;
    const onState = (state: Stroke[]) => setStrokes((state || []).filter((item) => item && (item.type === 'draw' || item.type === 'text')));
    const onDraw = (stroke: Stroke) => setStrokes((old) => old.some((item) => item.id === stroke.id) ? old : [...old, stroke]);
    const onUndo = ({ id }: { id: string }) => setStrokes((old) => old.filter((item) => item.id !== id));
    const onClear = () => setStrokes([]);
    socket.on('board:state', onState); socket.on('board:draw', onDraw); socket.on('board:undo', onUndo); socket.on('board:cleared', onClear);
    if (socket.connected) socket.emit('board:sync');
    return () => { socket.off('board:state', onState); socket.off('board:draw', onDraw); socket.off('board:undo', onUndo); socket.off('board:cleared', onClear); };
  }, [socket]);

  const getPoint = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) };
  };
  const drawSegment = (from: Point, to: Point, current: Stroke) => {
    const canvas = canvasRef.current; const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.save(); ctx.strokeStyle = current.tool === 'eraser' ? '#fdfdfd' : current.color;
    ctx.lineWidth = current.width * (canvas.width / 1000); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(from.x * canvas.width, from.y * canvas.height); ctx.lineTo(to.x * canvas.width, to.y * canvas.height); ctx.stroke(); ctx.restore();
  };
  const pointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 && event.pointerType !== 'touch') return;
    event.preventDefault();
    if (tool === 'text') {
      cancelTextEntryRef.current = false;
      setTextEntry({ point: getPoint(event), value: '' });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    const point = getPoint(event); pointsRef.current = [point];
    const draft: Stroke = { id: crypto.randomUUID(), type: 'draw', tool, color, width, points: [point], ownerId: participantId };
    liveStrokeRef.current = draft;
    render(strokes);
  };
  const pointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current || !liveStrokeRef.current) return;
    const next = getPoint(event); const previous = pointsRef.current[pointsRef.current.length - 1];
    if (!previous) return;
    pointsRef.current.push(next); liveStrokeRef.current.points = pointsRef.current;
    drawSegment(previous, next, liveStrokeRef.current);
  };
  const pointerUp = () => {
    if (!drawingRef.current || !liveStrokeRef.current) return;
    drawingRef.current = false;
    const completed = { ...liveStrokeRef.current, points: [...pointsRef.current] };
    if (completed.points.length) {
      submitStroke(completed);
    }
    liveStrokeRef.current = null; pointsRef.current = [];
  };
  const submitStroke = (stroke: Stroke) => {
    if (!socket?.connected) {
      setStatus('Not shared: reconnect and try again');
      render(strokes);
      return;
    }
    setStatus('Sharing…');
    socket.timeout(8000).emit('board:draw', stroke, (timeoutError: Error | null, result: { ok?: boolean; error?: string; stroke?: Stroke }) => {
      if (timeoutError) {
        setStatus('Checking whether the change was shared…');
        socket.emit('board:sync');
        return;
      }
      if (!result?.ok) {
        setStatus(result?.error || 'Not shared: please try again');
        render(strokes);
        return;
      }
      const accepted = result.stroke || stroke;
      setStrokes((old) => old.some((item) => item.id === accepted.id) ? old : [...old, accepted]);
      setStatus('Changes shared');
    });
  };
  const commitText = () => {
    if (cancelTextEntryRef.current) { cancelTextEntryRef.current = false; return; }
    if (!textEntry) return;
    const text = textEntry.value.trim().slice(0, 500);
    if (text) submitStroke({ id: crypto.randomUUID(), type: 'text', tool: 'pen', text, color, width, points: [textEntry.point], ownerId: participantId });
    setTextEntry(null);
  };
  const undo = () => {
    const last = [...strokes].reverse().find((stroke) => canClear || stroke.ownerId === participantId);
    if (!last) return;
    if (!socket?.connected) { setStatus('Not connected: undo was not sent'); return; }
    setStatus('Undoing…');
    socket.timeout(8000).emit('board:undo', { id: last.id }, (timeoutError: Error | null, result: { ok?: boolean; error?: string }) => {
      if (timeoutError) { setStatus('Checking whether undo was applied…'); socket.emit('board:sync'); return; }
      setStatus(result?.ok ? 'Changes shared' : result?.error || 'Undo failed. Please try again.');
    });
  };
  const clearBoard = () => {
    if (!canClear || !strokes.length || !window.confirm('Clear the shared whiteboard for everyone? This cannot be undone.')) return;
    if (!socket?.connected) { setStatus('Not connected: board was not cleared'); return; }
    setStatus('Clearing board…');
    socket.timeout(8000).emit('board:clear', (timeoutError: Error | null, result: { ok?: boolean; error?: string }) => {
      if (timeoutError) { setStatus('Checking whether the board was cleared…'); socket.emit('board:sync'); return; }
      setStatus(result?.ok ? 'Board cleared for everyone' : result?.error || 'Could not clear the board.');
    });
  };
  const downloadPng = () => {
    const canvas = canvasRef.current; if (!canvas) return;
    const anchor = document.createElement('a'); anchor.download = 'class-whiteboard.png'; anchor.href = canvas.toDataURL('image/png'); anchor.click();
  };

  return <div className="whiteboard-shell">
    <div className="whiteboard-toolbar"><div className="board-title-block"><strong>Shared whiteboard</strong><span><span className="online-dot" /> {status} · Visible to everyone</span></div><div className="board-tools"><button className={`board-tool ${tool === 'pen' ? 'board-tool-active' : ''}`} onClick={() => setTool('pen')} title="Pen" aria-label="Pen"><PenLine size={17} /><span>Pen</span></button><button className={`board-tool ${tool === 'text' ? 'board-tool-active' : ''}`} onClick={() => setTool('text')} title="Add text" aria-label="Add text"><Type size={17} /><span>Text</span></button><button className={`board-tool ${tool === 'eraser' ? 'board-tool-active' : ''}`} onClick={() => setTool('eraser')} title="Eraser" aria-label="Eraser"><Eraser size={17} /><span>Erase</span></button><label className="board-color" title="Pen colour" aria-label="Pen colour"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} disabled={tool === 'eraser'} /><span style={{ backgroundColor: color }} /></label><select className="board-width-select" value={width} onChange={(e) => setWidth(Number(e.target.value))} aria-label="Pen width"><option value={2}>Fine</option><option value={4}>Medium</option><option value={7}>Thick</option><option value={11}>Extra thick</option></select><button className="board-tool" onClick={undo} title="Undo your last item" aria-label="Undo" disabled={!strokes.some((stroke) => canClear || stroke.ownerId === participantId)}><RotateCcw size={16} /><span>Undo</span></button>{canClear && <button className="board-tool" onClick={clearBoard} title="Clear board for everyone" aria-label="Clear board"><Trash2 size={16} /><span>Clear</span></button>}<span className="board-tool-divider" /><button className="board-tool" onClick={() => setZoom((v) => Math.max(60, v - 10))} title="Zoom out" aria-label="Zoom out"><ZoomOut size={16} /></button><span className="zoom-level">{zoom}%</span><button className="board-tool" onClick={() => setZoom((v) => Math.min(140, v + 10))} title="Zoom in" aria-label="Zoom in"><ZoomIn size={16} /></button><button className="button button-outline button-small" onClick={downloadPng}>Save image</button></div></div>
    <div className="whiteboard-viewport"><div className="whiteboard-paper" style={{ width: `${zoom}%` }}><canvas ref={canvasRef} width={BOARD_WIDTH} height={BOARD_HEIGHT} className="whiteboard-canvas" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onLostPointerCapture={pointerUp} aria-label="Shared whiteboard canvas" />{textEntry && <input className="whiteboard-text-entry" autoFocus maxLength={500} aria-label="Text to add to whiteboard" placeholder="Type here…" value={textEntry.value} style={{ left: `${Math.min(textEntry.point.x * 100, 76)}%`, top: `${textEntry.point.y * 100}%`, color, fontSize: `${Math.max(14, (canvasRef.current?.clientWidth || 1600) / BOARD_WIDTH * width * 5)}px` }} onChange={(event) => setTextEntry((old) => old ? { ...old, value: event.target.value } : old)} onBlur={commitText} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } else if (event.key === 'Escape') { event.preventDefault(); cancelTextEntryRef.current = true; setTextEntry(null); } }} />}</div></div>
    <div className="whiteboard-footer"><span><MousePointer2 size={14} /> Everyone in this class can draw or add text</span><span>{strokes.length} items · {status}</span></div>
  </div>;
}
