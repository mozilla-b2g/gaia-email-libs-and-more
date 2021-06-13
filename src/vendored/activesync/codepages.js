/* Copyright 2012 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

define([
      'wbxml',
      './codepages/Common',
      './codepages/AirSync',
      './codepages/Contacts',
      './codepages/Email',
      './codepages/Calendar',
      './codepages/Move',
      './codepages/ItemEstimate',
      './codepages/FolderHierarchy',
      './codepages/MeetingResponse',
      './codepages/Tasks',
      './codepages/ResolveRecipients',
      './codepages/ValidateCert',
      './codepages/Contacts2',
      './codepages/Ping',
      './codepages/Provision',
      './codepages/Search',
      './codepages/GAL',
      './codepages/AirSyncBase',
      './codepages/Settings',
      './codepages/DocumentLibrary',
      './codepages/ItemOperations',
      './codepages/ComposeMail',
      './codepages/Email2',
      './codepages/Notes',
      './codepages/RightsManagement'
    ], function(WBXML, Common, AirSync, Contacts, Email, Calendar, Move,
                 ItemEstimate, FolderHierarchy, MeetingResponse, Tasks,
                 ResolveRecipients, ValidateCert, Contacts2, Ping, Provision,
                 Search, GAL, AirSyncBase, Settings, DocumentLibrary,
                 ItemOperations, ComposeMail, Email2, Notes, RightsManagement) {
  'use strict';

  var codepages = {
    Common: Common,
    AirSync: AirSync,
    Contacts: Contacts,
    Email: Email,
    Calendar: Calendar,
    Move: Move,
    ItemEstimate: ItemEstimate,
    FolderHierarchy: FolderHierarchy,
    MeetingResponse: MeetingResponse,
    Tasks: Tasks,
    ResolveRecipients: ResolveRecipients,
    ValidateCert: ValidateCert,
    Contacts2: Contacts2,
    Ping: Ping,
    Provision: Provision,
    Search: Search,
    GAL: GAL,
    AirSyncBase: AirSyncBase,
    Settings: Settings,
    DocumentLibrary: DocumentLibrary,
    ItemOperations: ItemOperations,
    ComposeMail: ComposeMail,
    Email2: Email2,
    Notes: Notes,
    RightsManagement: RightsManagement
  };

  WBXML.CompileCodepages(codepages);

  return codepages;
});
