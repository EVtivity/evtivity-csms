import type { CustomDataType } from './CustomDataType.js';
import type { SignedMeterValueType } from './SignedMeterValueType.js';
import type { UnitOfMeasureType } from './UnitOfMeasureType.js';

import type { LocationEnum } from '../../enums/LocationEnum.js';
import type { MeasurandEnum } from '../../enums/MeasurandEnum.js';
import type { PhaseEnum } from '../../enums/PhaseEnum.js';
import type { ReadingContextEnum } from '../../enums/ReadingContextEnum.js';

export interface SampledValueType {
  customData?: CustomDataType;
  value: number;
  context?: ReadingContextEnum;
  measurand?: MeasurandEnum;
  phase?: PhaseEnum;
  location?: LocationEnum;
  signedMeterValue?: SignedMeterValueType;
  unitOfMeasure?: UnitOfMeasureType;
}
