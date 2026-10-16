// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type {SqlModule} from '../../public/extra_sql_packages';
import {STITCHED_CORE_MODULE} from './core_sql';
import {STITCHED_CPU_SAMPLES_MODULE} from './cpu_samples_sql';
import {
  STITCHED_FLOWS_DOWN_MODULE,
  STITCHED_FLOWS_UP_MODULE,
} from './flows_sql';

// Every module of the stitched flamegraph SQL package.
export const STITCHED_SQL_MODULES: ReadonlyArray<SqlModule> = [
  STITCHED_CORE_MODULE,
  STITCHED_FLOWS_DOWN_MODULE,
  STITCHED_FLOWS_UP_MODULE,
  STITCHED_CPU_SAMPLES_MODULE,
];
