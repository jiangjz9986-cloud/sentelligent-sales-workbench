export function canSaveRegionProfileForWeek({
  loadedWeekStart,
  selectedWeekStart,
  draftWeekStart,
}) {
  return Boolean(
    loadedWeekStart
    && loadedWeekStart === selectedWeekStart
    && draftWeekStart === selectedWeekStart,
  );
}
