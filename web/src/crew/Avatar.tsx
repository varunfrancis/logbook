import { ACCESSORY_COLOR, mix, SHAPES } from './shapes.ts';

export type Mood = 'working' | 'needs' | 'break' | 'stuck' | 'shipped' | 'out';
export type AvatarProps = { shape: string; color: string; accessory?: string; job?: string; mood?: Mood; size?: number; title?: string };

/** Maps a session to the face it should make. */
export function moodFor(s: { status: string; stuck?: unknown; stamp?: string | null; away?: boolean }): Mood {
  if (s.status === 'needs_input') return 'needs';
  if (s.stuck) return 'stuck';
  if (s.status === 'running') return 'working';
  if (s.status === 'idle') return 'break';
  return s.stamp === 'shipped' ? 'shipped' : 'out';
}

/** One crew member, drawn from the same shape, color and accessories as their 3D character in the town. */
export function Avatar({ shape, color, accessory = 'none', job = 'none', mood = 'working', size = 48, title }: AvatarProps) {
  const sh = SHAPES[shape] ?? SHAPES.bean;
  const f = sh.face, top = sh.top, neck = sh.neck, h = sh.half;
  const shade = mix(color, 0.35, 0);
  const acc = ACCESSORY_COLOR[accessory] ?? '#e5484d', accDark = mix(acc, 0.3, 0);
  const hatJob = job === 'builder' || job === 'painter';
  const ink = '#1d232c';
  const propX = 50 + h + 4, propY = f + 6;
  const big = size >= 40; // small sizes drop fine detail so the silhouette stays readable
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" role="img" aria-label={title ?? `${shape} crew member`} style={{ display: 'block', overflow: 'visible', flex: 'none' }}>
      {big ? <ellipse cx="60" cy="112" rx="34" ry="5" fill="#25303d" opacity=".12" /> : null}
      <g transform="translate(10,10)">
        {mood === 'needs' || mood === 'out' ? (
          <path d={`M${50 + h - 4} ${f + 4} C${50 + h + 6} ${f - 6} ${50 + h + 10} ${f - 26} ${50 + h + 4} ${f - 30} C${50 + h - 2} ${f - 32} ${50 + h - 6} ${f - 20} ${50 + h - 10} ${f - 6} Z`} fill={color} stroke={shade} strokeWidth="2" />
        ) : null}
        <path d={sh.d} fill={color} />
        <path d={sh.d} fill="none" stroke={shade} strokeWidth={big ? 2.5 : 4} opacity=".55" />
        {big ? <ellipse cx={50 - h * 0.45} cy={top + 16} rx="9" ry="6" fill="#fff" opacity=".35" transform={`rotate(-25 ${50 - h * 0.45} ${top + 16})`} /> : null}

        {accessory === 'scarf' ? <><rect x={50 - h * 0.8} y={neck - 6} width={h * 1.6} height="9" rx="4.5" fill={acc} />{big ? <rect x={50 + h * 0.3} y={neck - 6} width="8" height="18" rx="3" fill={acc} /> : null}</> : null}
        {accessory === 'bow' ? <><path d={`M50 ${neck} L${39} ${neck - 7} L${39} ${neck + 7} Z M50 ${neck} L${61} ${neck - 7} L${61} ${neck + 7} Z`} fill={acc} /><circle cx="50" cy={neck} r="3.2" fill={accDark} /></> : null}
        {accessory === 'freckles' && big ? <g fill={shade} opacity=".7"><circle cx={28} cy={f + 8} r="1.4" /><circle cx={32} cy={f + 11} r="1.4" /><circle cx={68} cy={f + 8} r="1.4" /><circle cx={72} cy={f + 11} r="1.4" /></g> : null}

        {mood === 'working' ? <>
          <rect x={35} y={f - 3} width="8" height="10" rx="3" fill={ink} /><rect x={57} y={f - 3} width="8" height="10" rx="3" fill={ink} />
          {big ? <path d={`M33 ${f - 9} L43 ${f - 7} M57 ${f - 7} L67 ${f - 9}`} stroke={ink} strokeWidth="2.4" strokeLinecap="round" fill="none" /> : null}
          {big ? <path d={`M46 ${f + 14} L54 ${f + 14}`} stroke={ink} strokeWidth="2.4" strokeLinecap="round" /> : null}
        </> : null}
        {mood === 'needs' ? <>
          <rect x={33} y={f - 7} width="11" height="15" rx="4" fill={ink} /><rect x={56} y={f - 7} width="11" height="15" rx="4" fill={ink} />
          <circle cx={37} cy={f - 3} r="2" fill="#fff" /><circle cx={60} cy={f - 3} r="2" fill="#fff" />
          {big ? <circle cx="50" cy={f + 15} r="3" fill={ink} /> : null}
        </> : null}
        {mood === 'break' ? <>
          <rect x={35} y={f} width="9" height="4.5" rx="2" fill={ink} /><rect x={57} y={f} width="9" height="4.5" rx="2" fill={ink} />
          <path d={`M33 ${f - 2} L45 ${f - 2} M55 ${f - 2} L67 ${f - 2}`} stroke={ink} strokeWidth="2" strokeLinecap="round" />
          {big ? <path d={`M46 ${f + 13} Q50 ${f + 17} 54 ${f + 13}`} stroke={ink} strokeWidth="2.2" strokeLinecap="round" fill="none" /> : null}
        </> : null}
        {mood === 'stuck' ? <g stroke={ink} strokeWidth="2.2" fill="none">
          <circle cx={39} cy={f} r="5.5" /><circle cx={39} cy={f} r="2" /><circle cx={61} cy={f} r="5.5" /><circle cx={61} cy={f} r="2" />
          {big ? <path d={`M44 ${f + 15} q3 -3 6 0 q3 3 6 0`} strokeLinecap="round" /> : null}
        </g> : null}
        {mood === 'shipped' ? <>
          <path d={`M33 ${f + 2} L39 ${f - 4} L45 ${f + 2} M55 ${f + 2} L61 ${f - 4} L67 ${f + 2}`} stroke={ink} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          {big ? <path d={`M43 ${f + 10} Q50 ${f + 21} 57 ${f + 10} Z`} fill={ink} /> : null}
          {big ? <><circle cx={29} cy={f + 9} r="4.5" fill="#ff7aa8" opacity=".55" /><circle cx={71} cy={f + 9} r="4.5" fill="#ff7aa8" opacity=".55" /></> : null}
        </> : null}
        {mood === 'out' ? <>
          <path d={`M34 ${f} Q39 ${f + 4} 44 ${f} M56 ${f} Q61 ${f + 4} 66 ${f}`} stroke={ink} strokeWidth="2.6" strokeLinecap="round" fill="none" />
          {big ? <path d={`M46 ${f + 13} Q50 ${f + 17} 54 ${f + 13}`} stroke={ink} strokeWidth="2.2" strokeLinecap="round" fill="none" /> : null}
        </> : null}

        {accessory === 'glasses' ? <g stroke="#25303d" strokeWidth="2.4" fill="#fff" fillOpacity=".18"><circle cx={39} cy={f} r="9" /><circle cx={61} cy={f} r="9" /><path d={`M48 ${f} L52 ${f}`} fill="none" /></g> : null}
        {accessory === 'headphones' ? <><path d={`M${50 - h + 2} ${f} Q50 ${top - 26} ${50 + h - 2} ${f}`} stroke="#25303d" strokeWidth="4.5" fill="none" strokeLinecap="round" /><rect x={50 - h - 4} y={f - 8} width="10" height="16" rx="4" fill={acc} /><rect x={50 + h - 6} y={f - 8} width="10" height="16" rx="4" fill={acc} /></> : null}
        {accessory === 'beanie' && !hatJob ? <><path d={`M${50 - h * 0.75} ${top + 10} Q50 ${top - 22} ${50 + h * 0.75} ${top + 10} Z`} fill={acc} /><rect x={50 - h * 0.78} y={top + 6} width={h * 1.56} height="7" rx="3.5" fill={accDark} /><circle cx="50" cy={top - 10} r="5" fill={accDark} /></> : null}

        {job === 'builder' ? <><path d={`M${50 - h * 0.72} ${top + 10} Q50 ${top - 20} ${50 + h * 0.72} ${top + 10} Z`} fill="#ffc928" /><rect x={50 - h * 0.9} y={top + 7} width={h * 1.8} height="5" rx="2.5" fill="#f0b400" /></> : null}
        {job === 'painter' ? <><ellipse cx="46" cy={top + 2} rx="22" ry="8" fill="#25303d" transform={`rotate(-12 46 ${top + 2})`} /><circle cx="48" cy={top - 6} r="2.5" fill="#25303d" /></> : null}
        {big && mood !== 'needs' ? <>
          {job === 'plumber' ? <g transform={`translate(${propX},${propY}) rotate(30)`}><rect x="-2.5" y="0" width="5" height="22" rx="2" fill="#8a94a3" /><path d="M-7 -6 a7 7 0 1 0 14 0 l-3 0 l0 4 l-8 0 l0 -4 z" fill="#8a94a3" /></g> : null}
          {job === 'painter' ? <g transform={`translate(${propX},${propY}) rotate(25)`}><rect x="-2" y="2" width="4" height="22" rx="2" fill="#a16207" /><path d="M-4 2 Q0 -12 4 2 Z" fill="#e5484d" /></g> : null}
          {job === 'inspector' ? <g transform={`translate(${propX},${propY})`}><circle r="8" fill="#cfe8ff" stroke="#25303d" strokeWidth="3" /><rect x="4" y="5" width="4" height="14" rx="2" fill="#25303d" transform="rotate(-40 6 12)" /></g> : null}
          {job === 'builder' ? <g transform={`translate(${propX},${propY}) rotate(20)`}><rect x="-2" y="0" width="4" height="22" rx="2" fill="#a16207" /><rect x="-8" y="-5" width="16" height="8" rx="2" fill="#6b7480" /></g> : null}
        </> : null}
        {job === 'librarian' && big ? <g transform={`translate(36,${neck - 12})`}><rect width="28" height="18" rx="2" fill="#3f8efc" /><rect x="13" width="2" height="18" fill="#2d4fd6" /></g> : null}
        {job === 'scout' && big ? <g transform={`translate(50,${neck})`}><circle cx="-6" r="5.5" fill="#25303d" /><circle cx="6" r="5.5" fill="#25303d" /><circle cx="-6" r="2.4" fill="#9cd3ff" /><circle cx="6" r="2.4" fill="#9cd3ff" /></g> : null}
      </g>
      {big && mood === 'break' ? <g transform="translate(86,78)"><rect width="14" height="16" rx="3" fill="#fff" stroke="#25303d" strokeWidth="2" /><path d="M14 4 q6 0 6 5 q0 5 -6 5" stroke="#25303d" strokeWidth="2" fill="none" /></g> : null}
      {big && mood === 'stuck' ? <g transform="translate(60,4)"><path d="M-20 8 a8 8 0 0 1 6 -12 a10 10 0 0 1 18 -2 a8 8 0 0 1 12 8 a6 6 0 0 1 -2 12 h-30 a6 6 0 0 1 -4 -6 z" fill="#8a94a3" /><path d="M-12 20 l-2 6 M-2 20 l-2 6 M8 20 l-2 6" stroke="#5a8fd6" strokeWidth="2.4" strokeLinecap="round" /></g> : null}
      {big && mood === 'shipped' ? <g fill="#ffc928"><path d="M14 22 l2 6 l6 2 l-6 2 l-2 6 l-2 -6 l-6 -2 l6 -2 z" /><path d="M102 30 l1.6 4.4 l4.4 1.6 l-4.4 1.6 l-1.6 4.4 l-1.6 -4.4 l-4.4 -1.6 l4.4 -1.6 z" /></g> : null}
      {mood === 'needs' ? <g transform="translate(104,18)"><circle r={big ? 11 : 16} fill="#e5484d" />{big ? <text y="5.5" textAnchor="middle" fill="#fff" fontFamily="Fredoka, Nunito, sans-serif" fontWeight="600" fontSize="16">!</text> : null}</g> : null}
    </svg>
  );
}

export function AgentAvatar({ agent, mood, size }: { agent: { shape: string; color: string; accessory: string; job: string; title: string }; mood?: Mood; size?: number }) {
  return <Avatar shape={agent.shape} color={agent.color} accessory={agent.accessory} job={agent.job} mood={mood} size={size} title={agent.title} />;
}
