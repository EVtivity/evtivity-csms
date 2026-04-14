// Copyright (c) 2024-2026 EVtivity. All rights reserved.
// SPDX-License-Identifier: BUSL-1.1

import type { TestCase } from './types.js';

// OCPP 2.1 CSMS tests - A-security
import { TC_A_01_CSMS } from './tests/v2_1/csms/A-security/TC_A_01_CSMS.js';
import { TC_A_02_CSMS } from './tests/v2_1/csms/A-security/TC_A_02_CSMS.js';
import { TC_A_03_CSMS } from './tests/v2_1/csms/A-security/TC_A_03_CSMS.js';
import { TC_A_04_CSMS } from './tests/v2_1/csms/A-security/TC_A_04_CSMS.js';
import { TC_A_06_CSMS } from './tests/v2_1/csms/A-security/TC_A_06_CSMS.js';
import { TC_A_07_CSMS } from './tests/v2_1/csms/A-security/TC_A_07_CSMS.js';
import { TC_A_08_CSMS } from './tests/v2_1/csms/A-security/TC_A_08_CSMS.js';
import { TC_A_09_CSMS } from './tests/v2_1/csms/A-security/TC_A_09_CSMS.js';
import { TC_A_10_CSMS } from './tests/v2_1/csms/A-security/TC_A_10_CSMS.js';
import { TC_A_11_CSMS } from './tests/v2_1/csms/A-security/TC_A_11_CSMS.js';
import { TC_A_12_CSMS } from './tests/v2_1/csms/A-security/TC_A_12_CSMS.js';
import { TC_A_14_CSMS } from './tests/v2_1/csms/A-security/TC_A_14_CSMS.js';
import { TC_A_19_CSMS } from './tests/v2_1/csms/A-security/TC_A_19_CSMS.js';

// OCPP 2.1 CSMS tests - B-provisioning
import { TC_B_01_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_01_CSMS.js';
import { TC_B_02_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_02_CSMS.js';
import { TC_B_06_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_06_CSMS.js';
import { TC_B_07_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_07_CSMS.js';
import { TC_B_08_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_08_CSMS.js';
import { TC_B_09_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_09_CSMS.js';
import { TC_B_10_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_10_CSMS.js';
import { TC_B_12_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_12_CSMS.js';
import { TC_B_13_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_13_CSMS.js';
import { TC_B_14_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_14_CSMS.js';
import { TC_B_18_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_18_CSMS.js';
import { TC_B_20_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_20_CSMS.js';
import { TC_B_21_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_21_CSMS.js';
import { TC_B_22_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_22_CSMS.js';
import { TC_B_25_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_25_CSMS.js';
import { TC_B_26_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_26_CSMS.js';
import { TC_B_27_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_27_CSMS.js';
import { TC_B_42_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_42_CSMS.js';
import { TC_B_44_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_44_CSMS.js';
import {
  TC_B_30_CSMS,
  TC_B_31_CSMS,
  TC_B_58_CSMS,
  TC_B_105_CSMS,
} from './tests/v2_1/csms/B-provisioning/TC_B_30_CSMS.js';
import { TC_B_100_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_100_CSMS.js';
import { TC_B_103_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_103_CSMS.js';
import { TC_B_104_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_104_CSMS.js';
import { TC_B_116_CSMS } from './tests/v2_1/csms/B-provisioning/TC_B_116_CSMS.js';

// OCPP 2.1 CSMS tests - C-authorization
import { TC_C_02_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_02_CSMS.js';
import { TC_C_06_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_06_CSMS.js';
import { TC_C_07_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_07_CSMS.js';
import { TC_C_08_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_08_CSMS.js';
import { TC_C_20_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_20_CSMS.js';
import { TC_C_37_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_37_CSMS.js';
import { TC_C_38_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_38_CSMS.js';
import { TC_C_39_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_39_CSMS.js';
import { TC_C_40_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_40_CSMS.js';
import { TC_C_43_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_43_CSMS.js';
import { TC_C_47_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_47_CSMS.js';
import { TC_C_48_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_48_CSMS.js';
import { TC_C_49_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_49_CSMS.js';
import { TC_C_50_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_50_CSMS.js';
import { TC_C_51_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_51_CSMS.js';
import { TC_C_52_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_52_CSMS.js';
import { TC_C_103_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_103_CSMS.js';
import { TC_C_104_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_104_CSMS.js';
import { TC_C_108_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_108_CSMS.js';
import { TC_C_113_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_113_CSMS.js';
import { TC_C_117_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_117_CSMS.js';
import { TC_C_118_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_118_CSMS.js';
import { TC_C_119_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_119_CSMS.js';
import { TC_C_120_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_120_CSMS.js';
import { TC_C_125_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_125_CSMS.js';
import { TC_C_126_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_126_CSMS.js';
import { TC_C_131_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_131_CSMS.js';
import { TC_C_132_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_132_CSMS.js';
import { TC_C_133_CSMS } from './tests/v2_1/csms/C-authorization/TC_C_133_CSMS.js';

// OCPP 2.1 CSMS tests - D-local-authorization-list
import {
  TC_D_01_CSMS,
  TC_D_02_CSMS,
  TC_D_03_CSMS,
  TC_D_04_CSMS,
} from './tests/v2_1/csms/D-local-authorization-list/TC_D_01_CSMS.js';
import {
  TC_D_08_CSMS,
  TC_D_09_CSMS,
} from './tests/v2_1/csms/D-local-authorization-list/TC_D_08_CSMS.js';

// OCPP 2.1 CSMS tests - E-transactions
import { TC_E_01_CSMS } from './tests/v2_1/csms/E-transactions/TC_E_01_CSMS.js';
import { TC_E_02_CSMS } from './tests/v2_1/csms/E-transactions/TC_E_02_CSMS.js';
import {
  TC_E_03_CSMS,
  TC_E_04_CSMS,
  TC_E_39_CSMS,
  TC_E_38_CSMS,
} from './tests/v2_1/csms/E-transactions/TC_E_03_CSMS.js';
import {
  TC_E_14_CSMS,
  TC_E_20_CSMS,
  TC_E_15_CSMS,
  TC_E_21_CSMS,
  TC_E_07_CSMS,
  TC_E_08_CSMS,
  TC_E_16_CSMS,
  TC_E_17_CSMS,
  TC_E_22_CSMS,
  TC_E_19_CSMS,
} from './tests/v2_1/csms/E-transactions/TC_E_06_CSMS.js';
import { TC_E_10_CSMS, TC_E_26_CSMS } from './tests/v2_1/csms/E-transactions/TC_E_10_CSMS.js';
import {
  TC_E_29_CSMS,
  TC_E_30_CSMS,
  TC_E_31_CSMS,
  TC_E_33_CSMS,
  TC_E_34_CSMS,
} from './tests/v2_1/csms/E-transactions/TC_E_14_CSMS.js';
import {
  TC_E_102_CSMS,
  TC_E_106_CSMS,
  TC_E_107_CSMS,
  TC_E_108_CSMS,
  TC_E_109_CSMS,
  TC_E_110_CSMS,
  TC_E_111_CSMS,
} from './tests/v2_1/csms/E-transactions/TC_E_16_CSMS.js';
import { TC_E_113_CSMS, TC_E_117_CSMS } from './tests/v2_1/csms/E-transactions/TC_E_17_CSMS.js';
import {
  TC_E_09_CSMS,
  TC_E_11_CSMS,
  TC_E_12_CSMS,
  TC_E_53_CSMS,
} from './tests/v2_1/csms/E-transactions/TC_E_09_CSMS.js';

// OCPP 2.1 CSMS tests - F-remote-control
import { TC_F_01_CSMS } from './tests/v2_1/csms/F-remote-control/TC_F_01_CSMS.js';
import {
  TC_F_02_CSMS,
  TC_F_03_CSMS,
  TC_F_04_CSMS,
} from './tests/v2_1/csms/F-remote-control/TC_F_02_CSMS.js';
import { TC_F_06_CSMS } from './tests/v2_1/csms/F-remote-control/TC_F_06_CSMS.js';
import {
  TC_F_11_CSMS,
  TC_F_12_CSMS,
  TC_F_13_CSMS,
  TC_F_14_CSMS,
  TC_F_15_CSMS,
  TC_F_18_CSMS,
  TC_F_20_CSMS,
  TC_F_23_CSMS,
  TC_F_24_CSMS,
  TC_F_27_CSMS,
  TC_F_100_CSMS,
} from './tests/v2_1/csms/F-remote-control/TC_F_11_CSMS.js';

// OCPP 2.1 CSMS tests - G-availability
import { TC_G_01_CSMS } from './tests/v2_1/csms/G-availability/TC_G_01_CSMS.js';
import {
  TC_G_03_CSMS,
  TC_G_04_CSMS,
  TC_G_07_CSMS,
  TC_G_08_CSMS,
  TC_G_11_CSMS,
  TC_G_17_CSMS,
} from './tests/v2_1/csms/G-availability/TC_G_03_CSMS.js';
import {
  TC_G_05_CSMS,
  TC_G_06_CSMS,
  TC_G_14_CSMS,
} from './tests/v2_1/csms/G-availability/TC_G_05_CSMS.js';
import { TC_G_20_CSMS } from './tests/v2_1/csms/G-availability/TC_G_20_CSMS.js';

// OCPP 2.1 CSMS tests - H-reservation
import {
  TC_H_01_CSMS,
  TC_H_07_CSMS,
  TC_H_08_CSMS,
  TC_H_14_CSMS,
  TC_H_15_CSMS,
  TC_H_19_CSMS,
  TC_H_20_CSMS,
  TC_H_22_CSMS,
} from './tests/v2_1/csms/H-reservation/TC_H_01_CSMS.js';
import { TC_H_17_CSMS } from './tests/v2_1/csms/H-reservation/TC_H_17_CSMS.js';

// OCPP 2.1 CSMS tests - I-tariff-and-cost
import { TC_I_01_CSMS } from './tests/v2_1/csms/I-tariff-and-cost/TC_I_01_CSMS.js';
import { TC_I_02_CSMS } from './tests/v2_1/csms/I-tariff-and-cost/TC_I_02_CSMS.js';
import {
  TC_I_101_CSMS,
  TC_I_102_CSMS,
  TC_I_105_CSMS,
  TC_I_106_CSMS,
} from './tests/v2_1/csms/I-tariff-and-cost/TC_I_101_CSMS.js';
import { TC_I_109_CSMS } from './tests/v2_1/csms/I-tariff-and-cost/TC_I_109_CSMS.js';
import { TC_I_110_CSMS } from './tests/v2_1/csms/I-tariff-and-cost/TC_I_110_CSMS.js';
import {
  TC_I_113_CSMS,
  TC_I_114_CSMS,
  TC_I_115_CSMS,
} from './tests/v2_1/csms/I-tariff-and-cost/TC_I_113_CSMS.js';
import { TC_I_122_CSMS } from './tests/v2_1/csms/I-tariff-and-cost/TC_I_122_CSMS.js';

// OCPP 2.1 CSMS tests - J-meter-values
import {
  TC_J_01_CSMS,
  TC_J_02_CSMS,
  TC_J_03_CSMS,
  TC_J_04_CSMS,
} from './tests/v2_1/csms/J-meter-values/TC_J_01_CSMS.js';
import {
  TC_J_07_CSMS,
  TC_J_08_CSMS,
  TC_J_09_CSMS,
  TC_J_10_CSMS,
  TC_J_11_CSMS,
} from './tests/v2_1/csms/J-meter-values/TC_J_07_CSMS.js';

// OCPP 2.1 CSMS tests - K-smart-charging
import {
  TC_K_01_CSMS,
  TC_K_02_CSMS,
  TC_K_03_CSMS,
  TC_K_10_CSMS,
  TC_K_15_CSMS,
  TC_K_19_CSMS,
  TC_K_60_CSMS,
  TC_K_100_CSMS,
  TC_K_101_CSMS,
  TC_K_102_CSMS,
  TC_K_104_CSMS,
  TC_K_106_CSMS,
  TC_K_109_CSMS,
} from './tests/v2_1/csms/K-smart-charging/TC_K_01_CSMS.js';
import {
  TC_K_05_CSMS,
  TC_K_06_CSMS,
  TC_K_08_CSMS,
} from './tests/v2_1/csms/K-smart-charging/TC_K_05_CSMS.js';
import { TC_K_117_CSMS } from './tests/v2_1/csms/K-smart-charging/TC_K_117_CSMS.js';
import { TC_K_126_CSMS } from './tests/v2_1/csms/K-smart-charging/TC_K_126_CSMS.js';
import {
  TC_K_04_CSMS,
  TC_K_70_CSMS,
  TC_K_118_CSMS,
  TC_K_121_CSMS,
} from './tests/v2_1/csms/K-smart-charging/TC_K_04_CSMS.js';
import {
  TC_K_29_CSMS,
  TC_K_30_CSMS,
  TC_K_31_CSMS,
  TC_K_32_CSMS,
  TC_K_33_CSMS,
  TC_K_34_CSMS,
  TC_K_35_CSMS,
  TC_K_36_CSMS,
} from './tests/v2_1/csms/K-smart-charging/TC_K_29_CSMS.js';
import { TC_K_37_CSMS } from './tests/v2_1/csms/K-smart-charging/TC_K_37_CSMS.js';
import { TC_K_43_CSMS, TC_K_44_CSMS } from './tests/v2_1/csms/K-smart-charging/TC_K_43_CSMS.js';
import { TC_K_48_CSMS, TC_K_52_CSMS } from './tests/v2_1/csms/K-smart-charging/TC_K_48_CSMS.js';
import { TC_K_50_CSMS, TC_K_51_CSMS } from './tests/v2_1/csms/K-smart-charging/TC_K_50_CSMS.js';
import { TC_K_53_CSMS, TC_K_55_CSMS } from './tests/v2_1/csms/K-smart-charging/TC_K_53_CSMS.js';
import {
  TC_K_57_CSMS,
  TC_K_114_CSMS,
  TC_K_115_CSMS,
} from './tests/v2_1/csms/K-smart-charging/TC_K_57_CSMS.js';
import {
  TC_K_58_CSMS,
  TC_K_59_CSMS,
  TC_K_113_CSMS,
} from './tests/v2_1/csms/K-smart-charging/TC_K_58_CSMS.js';

// OCPP 2.1 CSMS tests - L-firmware-management
import {
  TC_L_01_CSMS,
  TC_L_02_CSMS,
  TC_L_03_CSMS,
  TC_L_04_CSMS,
  TC_L_05_CSMS,
  TC_L_06_CSMS,
  TC_L_07_CSMS,
  TC_L_08_CSMS,
  TC_L_09_CSMS,
  TC_L_10_CSMS,
  TC_L_11_CSMS,
  TC_L_13_CSMS,
} from './tests/v2_1/csms/L-firmware-management/TC_L_01_CSMS.js';
import {
  TC_L_17_CSMS,
  TC_L_24_CSMS,
  TC_L_19_CSMS,
  TC_L_20_CSMS,
} from './tests/v2_1/csms/L-firmware-management/TC_L_03_CSMS.js';
import {
  TC_L_21_CSMS,
  TC_L_22_CSMS,
  TC_L_23_CSMS,
} from './tests/v2_1/csms/L-firmware-management/TC_L_04_CSMS.js';

// OCPP 2.1 CSMS tests - M-certificate-management
import {
  TC_M_26_CSMS,
  TC_M_100_CSMS,
} from './tests/v2_1/csms/M-certificate-management/TC_M_01_CSMS.js';
import { TC_M_28_CSMS } from './tests/v2_1/csms/M-certificate-management/TC_M_02_CSMS.js';
import {
  TC_M_12_CSMS,
  TC_M_13_CSMS,
  TC_M_14_CSMS,
  TC_M_15_CSMS,
  TC_M_16_CSMS,
  TC_M_17_CSMS,
  TC_M_18_CSMS,
  TC_M_19_CSMS,
} from './tests/v2_1/csms/M-certificate-management/TC_M_03_CSMS.js';
import {
  TC_M_20_CSMS,
  TC_M_21_CSMS,
} from './tests/v2_1/csms/M-certificate-management/TC_M_04_CSMS.js';
import {
  TC_M_01_CSMS,
  TC_M_02_CSMS,
  TC_M_03_CSMS,
  TC_M_04_CSMS,
  TC_M_05_CSMS,
  TC_M_101_CSMS,
} from './tests/v2_1/csms/M-certificate-management/TC_M_05_CSMS.js';
import { TC_M_24_CSMS } from './tests/v2_1/csms/M-certificate-management/TC_M_06_CSMS.js';

// OCPP 2.1 CSMS tests - N-diagnostics
import {
  TC_N_25_CSMS,
  TC_N_34_CSMS,
  TC_N_35_CSMS,
  TC_N_36_CSMS,
  TC_N_100_CSMS,
  TC_N_102_CSMS,
  TC_N_102_2_CSMS,
} from './tests/v2_1/csms/N-diagnostics/TC_N_01_CSMS.js';
import {
  TC_N_01_CSMS,
  TC_N_02_CSMS,
  TC_N_03_CSMS,
  TC_N_60_CSMS,
  TC_N_47_CSMS,
  TC_N_104_CSMS,
} from './tests/v2_1/csms/N-diagnostics/TC_N_02_CSMS.js';
import { TC_N_05_CSMS } from './tests/v2_1/csms/N-diagnostics/TC_N_03_CSMS.js';
import { TC_N_08_CSMS, TC_N_09_CSMS } from './tests/v2_1/csms/N-diagnostics/TC_N_04_CSMS.js';
import { TC_N_16_CSMS, TC_N_17_CSMS } from './tests/v2_1/csms/N-diagnostics/TC_N_05_CSMS.js';
import { TC_N_18_CSMS, TC_N_44_CSMS } from './tests/v2_1/csms/N-diagnostics/TC_N_06_CSMS.js';
import {
  TC_N_21_CSMS,
  TC_N_48_CSMS,
  TC_N_49_CSMS,
  TC_N_50_CSMS,
} from './tests/v2_1/csms/N-diagnostics/TC_N_07_CSMS.js';
import { TC_N_24_CSMS } from './tests/v2_1/csms/N-diagnostics/TC_N_08_CSMS.js';
import {
  TC_N_27_CSMS,
  TC_N_28_CSMS,
  TC_N_29_CSMS,
} from './tests/v2_1/csms/N-diagnostics/TC_N_09_CSMS.js';
import {
  TC_N_30_CSMS,
  TC_N_31_CSMS,
  TC_N_32_CSMS,
  TC_N_62_CSMS,
  TC_N_63_CSMS,
  TC_N_46_CSMS,
} from './tests/v2_1/csms/N-diagnostics/TC_N_10_CSMS.js';
import { TC_N_105_CSMS } from './tests/v2_1/csms/N-diagnostics/TC_N_11_CSMS.js';
import { TC_N_107_CSMS } from './tests/v2_1/csms/N-diagnostics/TC_N_12_CSMS.js';

// OCPP 2.1 CSMS tests - O-display-message
import {
  TC_O_01_CSMS,
  TC_O_13_CSMS,
  TC_O_14_CSMS,
  TC_O_17_CSMS,
  TC_O_18_CSMS,
  TC_O_19_CSMS,
  TC_O_25_CSMS,
  TC_O_26_CSMS,
  TC_O_100_CSMS,
  TC_O_101_CSMS,
} from './tests/v2_1/csms/O-display-message/TC_O_01_CSMS.js';
import {
  TC_O_06_CSMS,
  TC_O_10_CSMS,
  TC_O_27_CSMS,
  TC_O_28_CSMS,
} from './tests/v2_1/csms/O-display-message/TC_O_02_CSMS.js';
import { TC_O_02_CSMS, TC_O_03_CSMS } from './tests/v2_1/csms/O-display-message/TC_O_03_CSMS.js';
import {
  TC_O_07_CSMS,
  TC_O_08_CSMS,
  TC_O_09_CSMS,
  TC_O_11_CSMS,
} from './tests/v2_1/csms/O-display-message/TC_O_04_CSMS.js';
import { TC_O_04_CSMS, TC_O_05_CSMS } from './tests/v2_1/csms/O-display-message/TC_O_05_CSMS.js';
import { TC_O_12_CSMS } from './tests/v2_1/csms/O-display-message/TC_O_06_CSMS.js';

// OCPP 2.1 CSMS tests - P-data-transfer
import { TC_P_02_CSMS, TC_P_03_CSMS } from './tests/v2_1/csms/P-data-transfer/TC_P_02_CSMS.js';

// OCPP 2.1 CSMS tests - Q-bidirectional-power-transfer
import {
  TC_Q_102_CSMS,
  TC_Q_103_CSMS,
} from './tests/v2_1/csms/Q-bidirectional-power-transfer/TC_Q_01_CSMS.js';
import { TC_Q_107_CSMS } from './tests/v2_1/csms/Q-bidirectional-power-transfer/TC_Q_02_CSMS.js';
import { TC_Q_108_CSMS } from './tests/v2_1/csms/Q-bidirectional-power-transfer/TC_Q_03_CSMS.js';
import {
  TC_Q_109_CSMS,
  TC_Q_110_CSMS,
} from './tests/v2_1/csms/Q-bidirectional-power-transfer/TC_Q_04_CSMS.js';
import {
  TC_Q_111_CSMS,
  TC_Q_112_CSMS,
} from './tests/v2_1/csms/Q-bidirectional-power-transfer/TC_Q_05_CSMS.js';
import { TC_Q_117_CSMS } from './tests/v2_1/csms/Q-bidirectional-power-transfer/TC_Q_07_CSMS.js';
import {
  TC_Q_120_CSMS,
  TC_Q_121_CSMS,
} from './tests/v2_1/csms/Q-bidirectional-power-transfer/TC_Q_08_CSMS.js';
import { TC_Q_124_CSMS } from './tests/v2_1/csms/Q-bidirectional-power-transfer/TC_Q_09_CSMS.js';

// OCPP 2.1 CSMS tests - R-der-control
import { TC_R_107_CSMS } from './tests/v2_1/csms/R-der-control/TC_R_04_CSMS.js';
import { TC_R_108_CSMS } from './tests/v2_1/csms/R-der-control/TC_R_05_CSMS.js';

// OCPP 2.1 CSMS tests - S-battery-swapping
import { TC_S_102_CSMS } from './tests/v2_1/csms/S-battery-swapping/TC_S_01_CSMS.js';
import { TC_S_103_CSMS } from './tests/v2_1/csms/S-battery-swapping/TC_S_02_CSMS.js';

// OCPP 1.6 CSMS tests
import { TC_001_CSMS } from './tests/v1_6/csms/TC_001_CSMS.js';
import { TC_003_CSMS } from './tests/v1_6/csms/TC_003_CSMS.js';
import { TC_004_1_CSMS } from './tests/v1_6/csms/TC_004_1_CSMS.js';
import { TC_004_2_CSMS } from './tests/v1_6/csms/TC_004_2_CSMS.js';
import { TC_005_1_CSMS } from './tests/v1_6/csms/TC_005_1_CSMS.js';
import { TC_007_CSMS } from './tests/v1_6/csms/TC_007_CSMS.js';
import { TC_010_CSMS } from './tests/v1_6/csms/TC_010_CSMS.js';
import { TC_011_1_CSMS } from './tests/v1_6/csms/TC_011_1_CSMS.js';
import { TC_011_2_CSMS } from './tests/v1_6/csms/TC_011_2_CSMS.js';
import { TC_012_CSMS } from './tests/v1_6/csms/TC_012_CSMS.js';
import { TC_013_CSMS } from './tests/v1_6/csms/TC_013_CSMS.js';
import { TC_014_CSMS } from './tests/v1_6/csms/TC_014_CSMS.js';
import { TC_017_1_CSMS } from './tests/v1_6/csms/TC_017_1_CSMS.js';
import { TC_017_2_CSMS } from './tests/v1_6/csms/TC_017_2_CSMS.js';
import { TC_018_1_CSMS } from './tests/v1_6/csms/TC_018_1_CSMS.js';
import { TC_019_1_CSMS } from './tests/v1_6/csms/TC_019_1_CSMS.js';
import { TC_019_2_CSMS } from './tests/v1_6/csms/TC_019_2_CSMS.js';
import { TC_021_CSMS } from './tests/v1_6/csms/TC_021_CSMS.js';
import { TC_023_1_CSMS } from './tests/v1_6/csms/TC_023_1_CSMS.js';
import { TC_023_2_CSMS } from './tests/v1_6/csms/TC_023_2_CSMS.js';
import { TC_023_3_CSMS } from './tests/v1_6/csms/TC_023_3_CSMS.js';
import { TC_024_CSMS } from './tests/v1_6/csms/TC_024_CSMS.js';
import { TC_026_CSMS } from './tests/v1_6/csms/TC_026_CSMS.js';
import { TC_028_CSMS } from './tests/v1_6/csms/TC_028_CSMS.js';
import { TC_030_CSMS } from './tests/v1_6/csms/TC_030_CSMS.js';
import { TC_031_CSMS } from './tests/v1_6/csms/TC_031_CSMS.js';
import { TC_032_1_CSMS } from './tests/v1_6/csms/TC_032_1_CSMS.js';
import { TC_037_1_CSMS } from './tests/v1_6/csms/TC_037_1_CSMS.js';
import { TC_037_3_CSMS } from './tests/v1_6/csms/TC_037_3_CSMS.js';
import { TC_039_CSMS } from './tests/v1_6/csms/TC_039_CSMS.js';
import { TC_040_1_CSMS } from './tests/v1_6/csms/TC_040_1_CSMS.js';
import { TC_040_2_CSMS } from './tests/v1_6/csms/TC_040_2_CSMS.js';
import { TC_042_1_CSMS } from './tests/v1_6/csms/TC_042_1_CSMS.js';
import { TC_042_2_CSMS } from './tests/v1_6/csms/TC_042_2_CSMS.js';
import { TC_043_1_CSMS } from './tests/v1_6/csms/TC_043_1_CSMS.js';
import { TC_043_3_CSMS } from './tests/v1_6/csms/TC_043_3_CSMS.js';
import { TC_043_4_CSMS } from './tests/v1_6/csms/TC_043_4_CSMS.js';
import { TC_043_5_CSMS } from './tests/v1_6/csms/TC_043_5_CSMS.js';
import { TC_044_1_CSMS } from './tests/v1_6/csms/TC_044_1_CSMS.js';
import { TC_044_2_CSMS } from './tests/v1_6/csms/TC_044_2_CSMS.js';
import { TC_044_3_CSMS } from './tests/v1_6/csms/TC_044_3_CSMS.js';
import { TC_045_1_CSMS } from './tests/v1_6/csms/TC_045_1_CSMS.js';
import { TC_045_2_CSMS } from './tests/v1_6/csms/TC_045_2_CSMS.js';
import { TC_046_CSMS } from './tests/v1_6/csms/TC_046_CSMS.js';
import { TC_047_CSMS } from './tests/v1_6/csms/TC_047_CSMS.js';
import { TC_048_1_CSMS } from './tests/v1_6/csms/TC_048_1_CSMS.js';
import { TC_048_2_CSMS } from './tests/v1_6/csms/TC_048_2_CSMS.js';
import { TC_048_3_CSMS } from './tests/v1_6/csms/TC_048_3_CSMS.js';
import { TC_048_4_CSMS } from './tests/v1_6/csms/TC_048_4_CSMS.js';
import { TC_049_CSMS } from './tests/v1_6/csms/TC_049_CSMS.js';
import { TC_051_CSMS } from './tests/v1_6/csms/TC_051_CSMS.js';
import { TC_052_CSMS } from './tests/v1_6/csms/TC_052_CSMS.js';
import { TC_053_CSMS } from './tests/v1_6/csms/TC_053_CSMS.js';
import { TC_054_CSMS } from './tests/v1_6/csms/TC_054_CSMS.js';
import { TC_055_CSMS } from './tests/v1_6/csms/TC_055_CSMS.js';
import { TC_056_CSMS } from './tests/v1_6/csms/TC_056_CSMS.js';
import { TC_057_CSMS } from './tests/v1_6/csms/TC_057_CSMS.js';
import { TC_059_CSMS } from './tests/v1_6/csms/TC_059_CSMS.js';
import { TC_061_CSMS } from './tests/v1_6/csms/TC_061_CSMS.js';
import { TC_064_CSMS } from './tests/v1_6/csms/TC_064_CSMS.js';
import { TC_066_CSMS } from './tests/v1_6/csms/TC_066_CSMS.js';
import { TC_067_CSMS } from './tests/v1_6/csms/TC_067_CSMS.js';
import { TC_073_CSMS } from './tests/v1_6/csms/TC_073_CSMS.js';
import { TC_074_CSMS } from './tests/v1_6/csms/TC_074_CSMS.js';
import { TC_075_1_CSMS } from './tests/v1_6/csms/TC_075_1_CSMS.js';
import { TC_075_2_CSMS } from './tests/v1_6/csms/TC_075_2_CSMS.js';
import { TC_076_CSMS } from './tests/v1_6/csms/TC_076_CSMS.js';
import { TC_077_CSMS } from './tests/v1_6/csms/TC_077_CSMS.js';
import { TC_078_CSMS } from './tests/v1_6/csms/TC_078_CSMS.js';
import { TC_079_CSMS } from './tests/v1_6/csms/TC_079_CSMS.js';
import { TC_080_CSMS } from './tests/v1_6/csms/TC_080_CSMS.js';
import { TC_081_CSMS } from './tests/v1_6/csms/TC_081_CSMS.js';
import { TC_083_CSMS } from './tests/v1_6/csms/TC_083_CSMS.js';
import { TC_085_CSMS } from './tests/v1_6/csms/TC_085_CSMS.js';
import { TC_086_CSMS } from './tests/v1_6/csms/TC_086_CSMS.js';
import { TC_087_CSMS } from './tests/v1_6/csms/TC_087_CSMS.js';
import { TC_088_CSMS } from './tests/v1_6/csms/TC_088_CSMS.js';

const ALL_TESTS: TestCase[] = [
  // OCPP 2.1 - A-security
  TC_A_01_CSMS,
  TC_A_02_CSMS,
  TC_A_03_CSMS,
  TC_A_04_CSMS,
  TC_A_06_CSMS,
  TC_A_07_CSMS,
  TC_A_08_CSMS,
  TC_A_09_CSMS,
  TC_A_10_CSMS,
  TC_A_11_CSMS,
  TC_A_12_CSMS,
  TC_A_14_CSMS,
  TC_A_19_CSMS,
  // OCPP 2.1 - B-provisioning
  TC_B_01_CSMS,
  TC_B_02_CSMS,
  TC_B_06_CSMS,
  TC_B_07_CSMS,
  TC_B_08_CSMS,
  TC_B_09_CSMS,
  TC_B_10_CSMS,
  TC_B_12_CSMS,
  TC_B_13_CSMS,
  TC_B_14_CSMS,
  TC_B_18_CSMS,
  TC_B_20_CSMS,
  TC_B_21_CSMS,
  TC_B_22_CSMS,
  TC_B_25_CSMS,
  TC_B_26_CSMS,
  TC_B_27_CSMS,
  TC_B_30_CSMS,
  TC_B_31_CSMS,
  TC_B_42_CSMS,
  TC_B_44_CSMS,
  TC_B_58_CSMS,
  TC_B_100_CSMS,
  TC_B_103_CSMS,
  TC_B_104_CSMS,
  TC_B_105_CSMS,
  TC_B_116_CSMS,
  // OCPP 2.1 - C-authorization
  TC_C_02_CSMS,
  TC_C_06_CSMS,
  TC_C_07_CSMS,
  TC_C_08_CSMS,
  TC_C_20_CSMS,
  TC_C_37_CSMS,
  TC_C_38_CSMS,
  TC_C_39_CSMS,
  TC_C_40_CSMS,
  TC_C_43_CSMS,
  TC_C_47_CSMS,
  TC_C_48_CSMS,
  TC_C_49_CSMS,
  TC_C_50_CSMS,
  TC_C_51_CSMS,
  TC_C_52_CSMS,
  TC_C_103_CSMS,
  TC_C_104_CSMS,
  TC_C_108_CSMS,
  TC_C_113_CSMS,
  TC_C_117_CSMS,
  TC_C_118_CSMS,
  TC_C_119_CSMS,
  TC_C_120_CSMS,
  TC_C_125_CSMS,
  TC_C_126_CSMS,
  TC_C_131_CSMS,
  TC_C_132_CSMS,
  TC_C_133_CSMS,
  // OCPP 2.1 - D-local-authorization-list
  TC_D_01_CSMS,
  TC_D_02_CSMS,
  TC_D_03_CSMS,
  TC_D_04_CSMS,
  TC_D_08_CSMS,
  TC_D_09_CSMS,
  // OCPP 2.1 - E-transactions
  TC_E_01_CSMS,
  TC_E_02_CSMS,
  TC_E_03_CSMS,
  TC_E_04_CSMS,
  TC_E_09_CSMS,
  TC_E_11_CSMS,
  TC_E_12_CSMS,
  TC_E_39_CSMS,
  TC_E_38_CSMS,
  TC_E_14_CSMS,
  TC_E_20_CSMS,
  TC_E_15_CSMS,
  TC_E_21_CSMS,
  TC_E_07_CSMS,
  TC_E_08_CSMS,
  TC_E_16_CSMS,
  TC_E_17_CSMS,
  TC_E_22_CSMS,
  TC_E_19_CSMS,
  TC_E_10_CSMS,
  TC_E_26_CSMS,
  TC_E_29_CSMS,
  TC_E_30_CSMS,
  TC_E_31_CSMS,
  TC_E_33_CSMS,
  TC_E_34_CSMS,
  TC_E_102_CSMS,
  TC_E_106_CSMS,
  TC_E_107_CSMS,
  TC_E_108_CSMS,
  TC_E_109_CSMS,
  TC_E_110_CSMS,
  TC_E_111_CSMS,
  TC_E_113_CSMS,
  TC_E_117_CSMS,
  TC_E_53_CSMS,
  // OCPP 2.1 - F-remote-control
  TC_F_01_CSMS,
  TC_F_02_CSMS,
  TC_F_03_CSMS,
  TC_F_04_CSMS,
  TC_F_06_CSMS,
  TC_F_11_CSMS,
  TC_F_12_CSMS,
  TC_F_13_CSMS,
  TC_F_14_CSMS,
  TC_F_15_CSMS,
  TC_F_18_CSMS,
  TC_F_20_CSMS,
  TC_F_23_CSMS,
  TC_F_24_CSMS,
  TC_F_27_CSMS,
  TC_F_100_CSMS,
  // OCPP 2.1 - G-availability
  TC_G_01_CSMS,
  TC_G_03_CSMS,
  TC_G_04_CSMS,
  TC_G_05_CSMS,
  TC_G_06_CSMS,
  TC_G_07_CSMS,
  TC_G_08_CSMS,
  TC_G_11_CSMS,
  TC_G_14_CSMS,
  TC_G_17_CSMS,
  TC_G_20_CSMS,
  // OCPP 2.1 - H-reservation
  TC_H_01_CSMS,
  TC_H_07_CSMS,
  TC_H_08_CSMS,
  TC_H_14_CSMS,
  TC_H_15_CSMS,
  TC_H_17_CSMS,
  TC_H_19_CSMS,
  TC_H_20_CSMS,
  TC_H_22_CSMS,
  // OCPP 2.1 - I-tariff-and-cost
  TC_I_01_CSMS,
  TC_I_02_CSMS,
  TC_I_101_CSMS,
  TC_I_102_CSMS,
  TC_I_105_CSMS,
  TC_I_106_CSMS,
  TC_I_109_CSMS,
  TC_I_110_CSMS,
  TC_I_113_CSMS,
  TC_I_114_CSMS,
  TC_I_115_CSMS,
  TC_I_122_CSMS,
  // OCPP 2.1 - J-meter-values
  TC_J_01_CSMS,
  TC_J_02_CSMS,
  TC_J_03_CSMS,
  TC_J_04_CSMS,
  TC_J_07_CSMS,
  TC_J_08_CSMS,
  TC_J_09_CSMS,
  TC_J_10_CSMS,
  TC_J_11_CSMS,
  // OCPP 2.1 - K-smart-charging
  TC_K_01_CSMS,
  TC_K_02_CSMS,
  TC_K_03_CSMS,
  TC_K_05_CSMS,
  TC_K_06_CSMS,
  TC_K_08_CSMS,
  TC_K_10_CSMS,
  TC_K_15_CSMS,
  TC_K_19_CSMS,
  TC_K_29_CSMS,
  TC_K_30_CSMS,
  TC_K_31_CSMS,
  TC_K_32_CSMS,
  TC_K_33_CSMS,
  TC_K_34_CSMS,
  TC_K_35_CSMS,
  TC_K_36_CSMS,
  TC_K_37_CSMS,
  TC_K_43_CSMS,
  TC_K_44_CSMS,
  TC_K_48_CSMS,
  TC_K_50_CSMS,
  TC_K_51_CSMS,
  TC_K_52_CSMS,
  TC_K_53_CSMS,
  TC_K_55_CSMS,
  TC_K_57_CSMS,
  TC_K_58_CSMS,
  TC_K_59_CSMS,
  TC_K_60_CSMS,
  TC_K_100_CSMS,
  TC_K_101_CSMS,
  TC_K_102_CSMS,
  TC_K_104_CSMS,
  TC_K_106_CSMS,
  TC_K_109_CSMS,
  TC_K_113_CSMS,
  TC_K_114_CSMS,
  TC_K_115_CSMS,
  TC_K_04_CSMS,
  TC_K_70_CSMS,
  TC_K_117_CSMS,
  TC_K_118_CSMS,
  TC_K_121_CSMS,
  TC_K_126_CSMS,
  // OCPP 2.1 - L-firmware-management
  TC_L_01_CSMS,
  TC_L_02_CSMS,
  TC_L_03_CSMS,
  TC_L_04_CSMS,
  TC_L_05_CSMS,
  TC_L_06_CSMS,
  TC_L_07_CSMS,
  TC_L_08_CSMS,
  TC_L_09_CSMS,
  TC_L_10_CSMS,
  TC_L_11_CSMS,
  TC_L_13_CSMS,
  TC_L_17_CSMS,
  TC_L_19_CSMS,
  TC_L_20_CSMS,
  TC_L_21_CSMS,
  TC_L_22_CSMS,
  TC_L_23_CSMS,
  TC_L_24_CSMS,
  // OCPP 2.1 - M-certificate-management
  TC_M_01_CSMS,
  TC_M_02_CSMS,
  TC_M_03_CSMS,
  TC_M_04_CSMS,
  TC_M_05_CSMS,
  TC_M_12_CSMS,
  TC_M_13_CSMS,
  TC_M_14_CSMS,
  TC_M_15_CSMS,
  TC_M_16_CSMS,
  TC_M_17_CSMS,
  TC_M_18_CSMS,
  TC_M_19_CSMS,
  TC_M_20_CSMS,
  TC_M_21_CSMS,
  TC_M_24_CSMS,
  TC_M_26_CSMS,
  TC_M_28_CSMS,
  TC_M_100_CSMS,
  TC_M_101_CSMS,
  // OCPP 2.1 - N-diagnostics
  TC_N_01_CSMS,
  TC_N_02_CSMS,
  TC_N_03_CSMS,
  TC_N_05_CSMS,
  TC_N_08_CSMS,
  TC_N_09_CSMS,
  TC_N_16_CSMS,
  TC_N_17_CSMS,
  TC_N_18_CSMS,
  TC_N_21_CSMS,
  TC_N_24_CSMS,
  TC_N_25_CSMS,
  TC_N_27_CSMS,
  TC_N_28_CSMS,
  TC_N_29_CSMS,
  TC_N_30_CSMS,
  TC_N_31_CSMS,
  TC_N_32_CSMS,
  TC_N_34_CSMS,
  TC_N_35_CSMS,
  TC_N_36_CSMS,
  TC_N_44_CSMS,
  TC_N_46_CSMS,
  TC_N_47_CSMS,
  TC_N_48_CSMS,
  TC_N_49_CSMS,
  TC_N_50_CSMS,
  TC_N_60_CSMS,
  TC_N_62_CSMS,
  TC_N_63_CSMS,
  TC_N_100_CSMS,
  TC_N_102_CSMS,
  TC_N_102_2_CSMS,
  TC_N_104_CSMS,
  TC_N_105_CSMS,
  TC_N_107_CSMS,
  // OCPP 2.1 - O-display-message
  TC_O_01_CSMS,
  TC_O_02_CSMS,
  TC_O_03_CSMS,
  TC_O_04_CSMS,
  TC_O_05_CSMS,
  TC_O_06_CSMS,
  TC_O_07_CSMS,
  TC_O_08_CSMS,
  TC_O_09_CSMS,
  TC_O_10_CSMS,
  TC_O_11_CSMS,
  TC_O_12_CSMS,
  TC_O_13_CSMS,
  TC_O_14_CSMS,
  TC_O_17_CSMS,
  TC_O_18_CSMS,
  TC_O_19_CSMS,
  TC_O_25_CSMS,
  TC_O_26_CSMS,
  TC_O_27_CSMS,
  TC_O_28_CSMS,
  TC_O_100_CSMS,
  TC_O_101_CSMS,
  // OCPP 2.1 - P-data-transfer
  TC_P_02_CSMS,
  TC_P_03_CSMS,
  // OCPP 2.1 - Q-bidirectional-power-transfer
  TC_Q_102_CSMS,
  TC_Q_103_CSMS,
  TC_Q_107_CSMS,
  TC_Q_108_CSMS,
  TC_Q_109_CSMS,
  TC_Q_110_CSMS,
  TC_Q_111_CSMS,
  TC_Q_112_CSMS,
  TC_Q_117_CSMS,
  TC_Q_120_CSMS,
  TC_Q_121_CSMS,
  TC_Q_124_CSMS,
  // OCPP 2.1 - R-der-control
  TC_R_107_CSMS,
  TC_R_108_CSMS,
  // OCPP 2.1 - S-battery-swapping
  TC_S_102_CSMS,
  TC_S_103_CSMS,
  // OCPP 1.6
  TC_001_CSMS,
  TC_003_CSMS,
  TC_004_1_CSMS,
  TC_004_2_CSMS,
  TC_005_1_CSMS,
  TC_007_CSMS,
  TC_010_CSMS,
  TC_011_1_CSMS,
  TC_011_2_CSMS,
  TC_012_CSMS,
  TC_013_CSMS,
  TC_014_CSMS,
  TC_017_1_CSMS,
  TC_017_2_CSMS,
  TC_018_1_CSMS,
  TC_019_1_CSMS,
  TC_019_2_CSMS,
  TC_021_CSMS,
  TC_023_1_CSMS,
  TC_023_2_CSMS,
  TC_023_3_CSMS,
  TC_024_CSMS,
  TC_026_CSMS,
  TC_028_CSMS,
  TC_030_CSMS,
  TC_031_CSMS,
  TC_032_1_CSMS,
  TC_037_1_CSMS,
  TC_037_3_CSMS,
  TC_039_CSMS,
  TC_040_1_CSMS,
  TC_040_2_CSMS,
  TC_042_1_CSMS,
  TC_042_2_CSMS,
  TC_043_1_CSMS,
  TC_043_3_CSMS,
  TC_043_4_CSMS,
  TC_043_5_CSMS,
  TC_044_1_CSMS,
  TC_044_2_CSMS,
  TC_044_3_CSMS,
  TC_045_1_CSMS,
  TC_045_2_CSMS,
  TC_046_CSMS,
  TC_047_CSMS,
  TC_048_1_CSMS,
  TC_048_2_CSMS,
  TC_048_3_CSMS,
  TC_048_4_CSMS,
  TC_049_CSMS,
  TC_051_CSMS,
  TC_052_CSMS,
  TC_053_CSMS,
  TC_054_CSMS,
  TC_055_CSMS,
  TC_056_CSMS,
  TC_057_CSMS,
  TC_059_CSMS,
  TC_061_CSMS,
  TC_064_CSMS,
  TC_066_CSMS,
  TC_067_CSMS,
  TC_073_CSMS,
  TC_074_CSMS,
  TC_075_1_CSMS,
  TC_075_2_CSMS,
  TC_076_CSMS,
  TC_077_CSMS,
  TC_078_CSMS,
  TC_079_CSMS,
  TC_080_CSMS,
  TC_081_CSMS,
  TC_083_CSMS,
  TC_085_CSMS,
  TC_086_CSMS,
  TC_087_CSMS,
  TC_088_CSMS,
];

const TEST_MAP = new Map<string, TestCase>(ALL_TESTS.map((tc) => [tc.id, tc]));

export function getRegistry(): TestCase[] {
  return [...ALL_TESTS];
}

export function getTestById(id: string): TestCase | undefined {
  return TEST_MAP.get(id);
}
