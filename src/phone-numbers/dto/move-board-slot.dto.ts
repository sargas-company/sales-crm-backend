import { IsInt, Max, Min, ValidateIf } from 'class-validator';

/** Board has 12 slots (2 columns × 6 rows) — see PhoneBoard page. */
const BOARD_MAX_SLOT = 11;

export class MoveBoardSlotDto {
  /**
   * Target slot (0-indexed), or `null` to unassign the card from the
   * board. `null` is accepted explicitly; any other non-integer or
   * out-of-range value is rejected by the global ValidationPipe.
   */
  @ValidateIf((o: MoveBoardSlotDto) => o.slot !== null)
  @IsInt()
  @Min(0)
  @Max(BOARD_MAX_SLOT)
  slot!: number | null;
}
