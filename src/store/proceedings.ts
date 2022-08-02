import type { Request } from '../types/request';
import { Message, MessageId, Proceeding, ProceedingStatus } from '../types/proceedings.d';
import create, { GetState, SetState, StoreApi, Mutate } from 'zustand';
import { persist } from 'zustand/middleware';
import { produce } from 'immer';
import { Privacy, PRIVACY_ACTIONS } from '../Utility/Privacy';
import type { SetOptional } from 'type-fest';
import { ErrorException } from '../Utility/errors';
import { UserRequest } from '../DataType/UserRequests';
import { isUserRequest } from '../Utility/requests';
import { PrivacyAsyncStorage } from '../Utility/PrivacyAsyncStorage';
import { t_r } from '../Utility/i18n';

export interface ProceedingsState {
    proceedings: Record<string, Proceeding>;
    addProceeding: (proceeding: Proceeding) => void;
    addRequest: (request: Request) => void;
    addMessage: (message: SetOptional<Message, 'id'>) => void;
    removeMessage: (id: MessageId) => void;
    addAttachment: (id: MessageId, file: unknown) => void;
    removeProceeding: (reference: string) => void;
    clearProceedings: () => void;
    updateStatuses: () => void;
    _hasHydrated: boolean;
    _migratedLegacyRequests: boolean;
    migrationDone: () => void;
    drink: () => void;
}

/** This is necessary because zustand/persist doesn't export `StorageValue` properly */
type ProceedingsStorageValue = { state: Partial<ProceedingsState>; version?: number };

const id_regex = /^(\d{4,}-[\dA-Za-z]{7,})-(\d+)$/;

const proceedingsStorage = new PrivacyAsyncStorage(() => Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_MY_REQUESTS), {
    name: 'Datenanfragen.de',
    storeName: 'proceedings',
});

const proceedingsStore = persist<ProceedingsState>(
    (set, get) => ({
        proceedings: {},
        drink: () => set({ _hasHydrated: true }),
        addProceeding: (proceeding) =>
            Privacy.isAllowed(PRIVACY_ACTIONS.SAVE_MY_REQUESTS) &&
            set(
                produce((state: ProceedingsState) => {
                    state.proceedings[proceeding.reference] = proceeding;
                })
            ),
        addRequest: (request) =>
            get().addProceeding(
                proceedingFromRequest(
                    request,
                    request.type !== 'custom' ? t_r(`letter-subject-${request.type}`, request.language) : undefined
                )
            ),
        addMessage: (message) =>
            set(
                produce((state: ProceedingsState) => {
                    if (!state.proceedings[message.reference])
                        throw new ErrorException(
                            'Adding the message failed: No proceeding exists for the given reference.',
                            message
                        );
                    const existing_ids = Object.keys(state.proceedings[message.reference].messages);
                    const message_id_number =
                        existing_ids.length > 0
                            ? Number.parseInt(existing_ids[existing_ids.length - 1].match(id_regex)?.[2] || '1', 10) + 1
                            : 0;
                    const message_id_string = `${message.reference}-${`${message_id_number}`.padStart(2, '0')}`;
                    message.id = message_id_string;
                    state.proceedings[message.reference].messages[message_id_string] = message as Message;
                    state.proceedings[message.reference].status = shouldHaveStatus(
                        state.proceedings[message.reference]
                    );
                })
            ),
        removeMessage: (id) =>
            set(
                produce((state: ProceedingsState) => {
                    const reference = id.match(id_regex)?.[1];
                    if (!reference) return;
                    delete state.proceedings[reference].messages[id];
                    state.proceedings[reference].status = shouldHaveStatus(state.proceedings[reference]);
                })
            ),
        // TODO: Implement a file API…
        addAttachment: (id, file) => {
            throw new ReferenceError('Not implemented');
        },
        removeProceeding: (reference) =>
            set(
                produce((state: ProceedingsState) => {
                    delete state.proceedings[reference];
                })
            ),
        clearProceedings: () => set({ proceedings: {} }),
        updateStatuses: () =>
            set(
                produce((state: ProceedingsState) => {
                    for (const [ref, prcd] of Object.entries(state.proceedings)) {
                        state.proceedings[ref].status = shouldHaveStatus(prcd);
                    }
                })
            ),
        // TODO: remove the my requests migration code and notify users about the migration
        migrationDone: () => set({ _migratedLegacyRequests: true }),
        _hasHydrated: false,
        _migratedLegacyRequests: false,
    }),
    {
        name: 'Datenanfragen.de-proceedings',
        version: 0,
        getStorage: () => proceedingsStorage,
        onRehydrateStorage: () => (state) => {
            if (!state) return;

            state.drink();
            state.updateStatuses();
        },
        deserialize: (str) =>
            produce(JSON.parse(str) as ProceedingsStorageValue, (stored_object) => {
                if (!stored_object.state.proceedings) return;

                for (const [reference, proceeding] of Object.entries(stored_object.state.proceedings)) {
                    for (const [id, message] of Object.entries(proceeding.messages)) {
                        stored_object.state.proceedings[reference].messages[id].date = new Date(message.date);
                    }
                }
            }),
    }
);

export const compareMessage = (msgA: Message, msgB: Message) => {
    if (msgA.date < msgB.date) return -1;
    else if (msgA.date == msgB.date) {
        if ((msgA.slug ?? 0) < (msgB.slug ?? 0)) return -1;
        else if (msgA.slug == msgB.slug) {
            if (msgA.reference < msgB.reference) return -1;
            else if (msgA.reference == msgB.reference) return 0;
            return 1;
        }
        return 1;
    }
    return 1;
};

export const getNewestMessage = (proceeding: Proceeding): Message | undefined => {
    const msgArray = Object.values(proceeding.messages).sort(compareMessage);
    return msgArray[msgArray.length - 1];
};

const shouldHaveStatus = (proceeding: Proceeding): ProceedingStatus => {
    if (proceeding.status === 'done') return 'done';
    const newestMessage = getNewestMessage(proceeding);
    if (newestMessage?.sentByMe) {
        const dueDate = new Date(newestMessage.date);
        dueDate.setDate(dueDate.getDate() + 32); // TODO: Make this a setting? Should this depend on context?
        return dueDate > new Date() ? 'waitingForResponse' : 'overdue';
    }

    return 'actionNeeded';
};

const { devtools } =
    process.env.NODE_ENV === 'development' ? require('zustand/middleware') : { devtools: (d: unknown) => d };

// These monster types are necessary because the type inference doesn't work anymore "if you do something fancy". The types are taken from https://github.com/pmndrs/zustand/blob/4d8003b363cb06ee5b1da498300a60576419485a/tests/middlewareTypes.test.tsx
// TODO: This seems to change in zustand v4 and should make inference possible again? Revisit this if we update!
export const useProceedingsStore =
    process.env.NODE_ENV === 'development'
        ? create<
              ProceedingsState,
              SetState<ProceedingsState>,
              GetState<ProceedingsState>,
              Mutate<
                  StoreApi<ProceedingsState>,
                  [['zustand/persist', Partial<ProceedingsState>], ['zustand/devtools', never]]
              >
          >(devtools(proceedingsStore))
        : create<
              ProceedingsState,
              SetState<ProceedingsState>,
              GetState<ProceedingsState>,
              Mutate<StoreApi<ProceedingsState>, [['zustand/persist', Partial<ProceedingsState>]]>
          >(proceedingsStore);

export const proceedingFromRequest = (
    request: Request | UserRequest,
    subject?: string,
    content?: string
): Proceeding => ({
    reference: request.reference,
    messages: {
        [`${request.reference}-00`]: {
            id: `${request.reference}-00`,
            reference: request.reference,
            date: new Date(request.date),
            type: request.type === 'custom' ? request.response_type || 'response' : request.type,
            slug: request.slug,
            correspondent_address: isUserRequest(request) ? request.recipient : request.recipient_address,
            correspondent_email: request.email,
            transport_medium: isUserRequest(request) ? request.via : request.transport_medium,
            subject,
            content,
            sentByMe: true,
        },
    },
    status: 'waitingForResponse',
});
