/**
 * Visual column ruler.
 *
 * Typing widths by hand is how people get fixed-width layouts wrong: an off-by-one in the
 * third field shifts every field after it, and the result still looks plausible. Clicking
 * the cut positions against real sample records makes the mistake visible immediately.
 */

const TICK_INTERVAL = 10;

export class Ruler {
  private lines: string[] = [];
  private cuts = new Set<number>();
  private charWidth = 8;
  private recordWidth = 0;

  constructor(
    private readonly track: HTMLElement,
    private readonly sample: HTMLElement,
    private readonly summary: HTMLElement,
    private readonly onChange: () => void,
  ) {
    this.track.addEventListener('click', (event) => this.handleClick(event));
  }

  setSample(lines: readonly string[]): void {
    this.lines = [...lines];
    this.recordWidth = this.lines.reduce((width, line) => Math.max(width, line.length), 0);
    this.renderSample();
    this.measureCharWidth();
    this.renderTrack();
    this.renderSummary();
  }

  /**
   * Measure the monospace advance once, from the rendered sample itself rather than from a
   * hardcoded constant: the user's editor font is whatever they configured.
   */
  private measureCharWidth(): void {
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(100);
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    this.sample.appendChild(probe);
    const width = probe.getBoundingClientRect().width / 100;
    probe.remove();
    if (width > 0) {
      this.charWidth = width;
    }
  }

  private renderSample(): void {
    // textContent, not innerHTML: these are raw bytes from a file we did not write.
    this.sample.textContent = this.lines.join('\n');
    this.sample.style.width = `${Math.max(this.recordWidth, 1) * this.charWidth}px`;
  }

  private handleClick(event: MouseEvent): void {
    const bounds = this.track.getBoundingClientRect();
    const column = Math.round((event.clientX - bounds.left) / this.charWidth);
    if (column <= 0 || column >= this.recordWidth) {
      return;
    }
    if (this.cuts.has(column)) {
      this.cuts.delete(column);
    } else {
      this.cuts.add(column);
    }
    this.renderTrack();
    this.renderSummary();
    this.onChange();
  }

  private renderTrack(): void {
    this.track.textContent = '';
    this.track.style.width = `${Math.max(this.recordWidth, 1) * this.charWidth}px`;

    for (let column = 0; column <= this.recordWidth; column += TICK_INTERVAL) {
      const tick = document.createElement('span');
      tick.className = 'ruler-tick';
      tick.style.left = `${column * this.charWidth}px`;
      tick.textContent = String(column);
      this.track.appendChild(tick);
    }

    for (const cut of this.cuts) {
      const marker = document.createElement('span');
      marker.className = 'ruler-cut';
      marker.style.left = `${cut * this.charWidth}px`;
      marker.title = `Cut at column ${cut} — click to remove`;
      this.track.appendChild(marker);

      // A full-height guide over the sample, so the cut can be checked against the data.
      const guide = document.createElement('span');
      guide.className = 'ruler-guide';
      guide.style.left = `${cut * this.charWidth}px`;
      this.track.appendChild(guide);
    }
  }

  private renderSummary(): void {
    const widths = this.widths();
    this.summary.textContent = widths.length > 0
      ? `${widths.length} columns · widths ${widths.join(', ')}`
      : 'No cuts placed yet.';
  }

  widths(): number[] {
    const sorted = [...this.cuts].sort((a, b) => a - b);
    const widths: number[] = [];
    let previous = 0;
    for (const cut of sorted) {
      widths.push(cut - previous);
      previous = cut;
    }
    if (this.recordWidth > previous) {
      widths.push(this.recordWidth - previous);
    }
    return widths;
  }

  setWidths(widths: readonly number[]): void {
    this.cuts.clear();
    let position = 0;
    for (const width of widths.slice(0, -1)) {
      position += width;
      if (position > 0 && position < this.recordWidth) {
        this.cuts.add(position);
      }
    }
    this.renderTrack();
    this.renderSummary();
  }

  clear(): void {
    this.cuts.clear();
    this.renderTrack();
    this.renderSummary();
    this.onChange();
  }
}
