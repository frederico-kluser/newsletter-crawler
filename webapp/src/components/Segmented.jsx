import {
  SegmentedToggle,
  SegmentedToggleOption,
} from '@/components/motion-ui/segmented-toggle';

/**
 * Controle segmentado (Tudo/Notícias/Ferramentas/Releases) sobre o primitivo SegmentedToggle
 * do Motion+ UI (snap spring + deformação elástica sutil `scaleX: [1, 1.06, 1]` no thumb).
 */
export default function Segmented({ value, options, onChange, label }) {
  return (
    <SegmentedToggle
      value={value}
      onChange={onChange}
      ariaLabel={label}
      layoutId="seg-thumb"
    >
      {options.map((opt) => (
        <SegmentedToggleOption key={opt.value} value={opt.value}>
          {opt.label}
        </SegmentedToggleOption>
      ))}
    </SegmentedToggle>
  );
}
